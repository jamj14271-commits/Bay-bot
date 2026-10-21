// Mineflayer bot: sinh tồn như người thật + đi theo người chơi + trộm rương có giới hạn
// env: MC_HOST, MC_PORT, BOT_NAME, MC_VERSION, AUTO_SURVIVE=1
const mineflayer = require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
const { plugin: toolPlugin } = require('mineflayer-tool')
const { Vec3 } = require('vec3')

const CONFIG = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT || '25565'),
  username: process.env.BOT_NAME || 'Nguoitinhbimatcuahau',
  version: process.env.MC_VERSION || false,
  autoSurvive: process.env.AUTO_SURVIVE === '1',
  followDistance: 2,
  stealCooldownMs: 60_000,
  stealMaxItems: 2,
  chestRange: 6,
  stealWhitelist: ['iron_ingot', 'gold_ingot', 'diamond', 'bread', 'cooked_beef', 'arrow'],
  stealBlacklist: ['netherite', 'elytra', 'totem', 'enchanted', 'shulker']
}

// ===== HTTP cho Render =====
require('http').createServer((req, res) => res.end('bot ok')).listen(process.env.PORT || 3000)

let bot, mcData
let followTarget = null
let lastSteal = 0
let busy = false      // đang mở rương/ăn
let survive = false   // chế độ sinh tồn

const sleep = ms => new Promise(r => setTimeout(r, ms))
const items = () => bot.inventory.items()
const countName = n => items().filter(i => i.name === n).reduce((a, i) => a + i.count, 0)
const countFn = f => items().filter(i => f(i.name)).reduce((a, i) => a + i.count, 0)
const has = n => countName(n) > 0
const is = names => b => b && names.includes(b.name)
const log = (...a) => console.log('[BOT]', ...a)

// ================= KHỞI TẠO =================
function startBot() {
  bot = mineflayer.createBot({
    host: CONFIG.host, port: CONFIG.port, username: CONFIG.username,
    auth: 'offline', version: CONFIG.version || undefined
  })
  bot.loadPlugin(pathfinder)
  bot.loadPlugin(toolPlugin)

  bot.once('spawn', () => {
    mcData = require('minecraft-data')(bot.version)
    const m = new Movements(bot)
    m.canDig = true
    m.allowParkour = true
    m.allow1by1towers = true
    bot.pathfinder.setMovements(m)
    bot.chat('Xin chào!')
    if (CONFIG.autoSurvive) startSurvive()
  })

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    const [cmd, arg] = message.trim().split(/\s+/)
    if (cmd === '!survive') startSurvive()
    else if (cmd === '!follow') {
      stopSurvive()
      followPlayer(arg || username)
    } else if (cmd === '!stop') {
      stopSurvive(); followTarget = null; bot.pathfinder.setGoal(null)
    } else if (cmd === '!steal') trySteal(true)
    else if (cmd === '!status') bot.chat(`HP ${Math.round(bot.health)} | food ${bot.food} | survive=${survive}`)
  })

  bot.on('playerLeft', p => {
    if (followTarget && followTarget.username === p.username) { followTarget = null; bot.pathfinder.setGoal(null) }
  })
  bot.on('death', () => { followTarget = null; log('đã chết') })
  bot.on('respawn', () => { if (survive) bot.pathfinder.setGoal(null) })
  bot.on('kicked', r => log('Bị kick:', JSON.stringify(r)))
  bot.on('error', e => log('Lỗi:', e.message))
  bot.on('end', () => {
    log('Mất kết nối, vào lại sau 10s')
    survive = false; followTarget = null; busy = false
    setTimeout(startBot, 10_000)
  })
}

function followPlayer(name) {
  const p = bot.players[name]
  if (!p || !p.entity) return bot.chat(`Không thấy ${name}`)
  followTarget = p.entity
  bot.pathfinder.setGoal(new goals.GoalFollow(followTarget, CONFIG.followDistance), true)
  bot.chat(`Đang đi theo ${name}`)
}

// ================= TIỆN ÍCH DI CHUYỂN =================
async function goNear(pos, range = 2, timeout = 20000) {
  const g = new goals.GoalNear(pos.x, pos.y, pos.z, range)
  await Promise.race([
    bot.pathfinder.goto(g),
    sleep(timeout).then(() => { bot.pathfinder.setGoal(null); throw new Error('goto timeout') })
  ])
}

async function explore() {
  const p = bot.entity.position
  const a = Math.random() * Math.PI * 2
  const d = 25 + Math.random() * 20
  try {
    await Promise.race([
      bot.pathfinder.goto(new goals.GoalXZ(Math.floor(p.x + Math.cos(a) * d), Math.floor(p.z + Math.sin(a) * d))),
      sleep(25000).then(() => { bot.pathfinder.setGoal(null); throw new Error('timeout') })
    ])
  } catch (e) { /* kệ */ }
}

async function pickupNearby() {
  for (let i = 0; i < 6; i++) {
    const it = bot.nearestEntity(e => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)
    if (!it) return
    try { await goNear(it.position, 1, 6000) } catch (e) { return }
    await sleep(200)
  }
}

// ================= ĐÀO / THU THẬP =================
async function collect(match, target, maxDist = 48) {
  let got = 0, fails = 0
  while (survive && got < target && fails < 4) {
    const b = bot.findBlock({ matching: match, maxDistance: maxDist })
    if (!b) { fails++; await explore(); continue }
    try {
      await goNear(b.position, 3)
      await bot.tool.equipForBlock(b, { requireHarvest: true })
      await bot.dig(b)
      got++
      await pickupNearby()
    } catch (e) { fails++ }
  }
  return got
}

// đào 1 bước hầm (xuống dốc hoặc ngang), tránh dung nham/nước
async function digStep(dir, down) {
  const p = bot.entity.position.floored()
  const f = p.plus(dir)
  const cells = down
    ? [f.offset(0, 1, 0), f, f.offset(0, -1, 0)]
    : [f.offset(0, 1, 0), f]
  const danger = [...cells, f.offset(0, -2, 0), f.offset(0, down ? 2 : 0, 0)]
  for (const c of danger) {
    const b = bot.blockAt(c)
    if (b && (b.name === 'lava' || b.name === 'water')) return false
  }
  for (const c of cells) {
    const b = bot.blockAt(c)
    if (b && b.diggable && b.boundingBox === 'block') {
      await bot.tool.equipForBlock(b)
      await bot.dig(b)
    }
  }
  const target = down ? f.offset(0, -1, 0) : f
  await goNear(target.offset(0.5, 0, 0.5), 0, 8000)
  return true
}

const DIRS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
let mineDir = DIRS[Math.floor(Math.random() * 4)]

// không thấy quặng: đào hầm tìm
async function stripMine() {
  const y = bot.entity.position.y
  for (let i = 0; i < 10 && survive; i++) {
    const ok = await digStep(mineDir, y > 40).catch(() => false)
    if (!ok) { mineDir = DIRS[Math.floor(Math.random() * 4)]; return }
    if (bot.entity.position.y <= 40) { // xuống đủ sâu thì đào ngang
      const ok2 = await digStep(mineDir, false).catch(() => false)
      if (!ok2) { mineDir = DIRS[Math.floor(Math.random() * 4)]; return }
    }
  }
}

async function mineOre(names, target) {
  const match = is(names)
  const got = await collect(match, target, 40)
  if (got === 0 && !bot.findBlock({ matching: match, maxDistance: 40 })) await stripMine()
  return got
}

// ================= CRAFT =================
async function craft(name, times = 1, table = null) {
  const it = mcData.itemsByName[name]
  if (!it) return false
  const rs = bot.recipesFor(it.id, null, 1, table)
  if (!rs.length) return false
  try { await bot.craft(rs[0], times, table); return true } catch (e) { return false }
}

const planksCount = () => countFn(n => n.endsWith('_planks'))
const logsCount = () => countFn(n => n.endsWith('_log'))

async function ensurePlanks(need) {
  while (planksCount() < need) {
    const log = items().find(i => i.name.endsWith('_log'))
    if (!log) return false
    if (!(await craft(log.name.replace('_log', '_planks'), 1))) return false
  }
  return true
}

async function placeNear(itemName) {
  const it = items().find(i => i.name === itemName)
  if (!it) return false
  await bot.equip(it, 'hand')
  const base = bot.entity.position.floored()
  for (const d of DIRS) {
    const ref = bot.blockAt(base.plus(d).offset(0, -1, 0))
    const above = bot.blockAt(base.plus(d))
    if (ref && above && ref.boundingBox === 'block' && above.name === 'air') {
      try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); return true } catch (e) { /* thử hướng khác */ }
    }
  }
  return false
}

const findBlockNamed = (name, dist = 32) =>
  bot.findBlock({ matching: b => b.name === name, maxDistance: dist })

async function getTable() {
  let t = findBlockNamed('crafting_table', 32)
  if (!t) {
    if (!has('crafting_table')) {
      if (!(await ensurePlanks(4)) || !(await craft('crafting_table'))) return null
    }
    if (!(await placeNear('crafting_table'))) { await explore(); return null }
    t = findBlockNamed('crafting_table', 8)
  }
  if (t) await goNear(t.position, 3)
  return t
}

// ================= LÒ NUNG =================
async function getFurnace() {
  let f = findBlockNamed('furnace', 32)
  if (f) { await goNear(f.position, 3); return f }
  if (countName('cobblestone') < 8) return null
  const t = await getTable()
  if (!t) return null
  if (!has('furnace') && !(await craft('furnace', 1, t))) return null
  if (!(await placeNear('furnace'))) { await explore(); return null }
  return findBlockNamed('furnace', 8)
}

async function smelt(inputName, n) {
  const f = await getFurnace()
  if (!f) return false
  const input = items().find(i => i.name === inputName)
  if (!input) return false
  n = Math.min(n, input.count)
  const coal = items().find(i => i.name === 'coal' || i.name === 'charcoal')
  const wood = items().find(i => i.name.endsWith('_log') || i.name.endsWith('_planks'))
  const fuel = coal || wood
  if (!fuel) return false
  const fuelNeed = coal ? Math.ceil(n / 8) : Math.ceil(n / 1.5)
  const furnace = await bot.openFurnace(f)
  try {
    await furnace.putFuel(fuel.type, null, Math.min(fuel.count, fuelNeed))
    await furnace.putInput(input.type, null, n)
    for (let s = 0; s < n * 11 + 5 && survive; s++) {
      await sleep(1000)
      const out = furnace.outputItem()
      if (out && out.count >= n) break
    }
    if (furnace.outputItem()) await furnace.takeOutput()
  } catch (e) { log('lỗi lò:', e.message) }
  furnace.close()
  return true
}

// ================= ĂN / SĂN BẮN =================
const RAW = ['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'potato']
const BAD_FOOD = ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chorus_fruit', 'suspicious_stew']
const edible = i => mcData.foodsByName[i.name] && !BAD_FOOD.includes(i.name)
const foodCount = () => items().filter(edible).reduce((a, i) => a + i.count, 0)

async function eatIfHungry(threshold = 14) {
  if (busy || bot.food === undefined || bot.food >= threshold) return
  const list = items().filter(edible).sort((a, b) =>
    mcData.foodsByName[b.name].foodPoints - mcData.foodsByName[a.name].foodPoints)
  if (!list.length) return
  try {
    busy = true
    await bot.equip(list[0], 'hand')
    await bot.consume()
  } catch (e) { /* kệ */ } finally { busy = false }
}

async function hunt(types, n) {
  let killed = 0, tries = 0
  while (survive && killed < n && tries < 8) {
    tries++
    const a = bot.nearestEntity(e => types.includes(e.name) && e.position.distanceTo(bot.entity.position) < 64)
    if (!a) { await explore(); continue }
    const weapon = items().find(i => i.name.endsWith('_sword')) || items().find(i => i.name.endsWith('_axe'))
    if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
    bot.pathfinder.setGoal(new goals.GoalFollow(a, 2), true)
    const t0 = Date.now()
    while (survive && a.isValid && Date.now() - t0 < 30000) {
      if (a.position.distanceTo(bot.entity.position) < 3.5) bot.attack(a)
      await sleep(600)
    }
    bot.pathfinder.setGoal(null)
    if (!a.isValid) { killed++; await pickupNearby() }
  }
  return killed
}

async function cookAll() {
  if (!findBlockNamed('furnace', 48)) return
  for (const r of RAW) {
    const c = countName(r)
    if (c > 0) await smelt(r, c)
  }
}

// ================= NGỦ =================
const bedBlock = () => bot.findBlock({ matching: b => b.name.endsWith('_bed'), maxDistance: 128 })

async function tryBed() {
  if (!bot.time.isDay) {
    const bed = bedBlock()
    if (!bed) return false
    try {
      await goNear(bed.position, 2, 40000)
      await bot.sleep(bed)
      while (bot.isSleeping && survive) await sleep(2000)
    } catch (e) { log('không ngủ được:', e.message); await sleep(5000) }
    return true
  }
  return false
}

async function getBed() {
  if (bedBlock()) return true
  const bedItem = items().find(i => i.name.endsWith('_bed'))
  if (bedItem) { await placeNear(bedItem.name); return true }
  const wool = () => {
    const m = {}
    for (const i of items()) if (i.name.endsWith('_wool')) m[i.name] = (m[i.name] || 0) + i.count
    return Object.entries(m).find(([, c]) => c >= 3)
  }
  let w = wool()
  for (let i = 0; i < 4 && !w && survive; i++) { await hunt(['sheep'], 2); w = wool() }
  if (!w) return false
  if (!(await ensurePlanks(3))) { await collect(n => n && n.name.endsWith('_log'), 2); return false }
  const t = await getTable()
  if (!t) return false
  if (await craft(w[0].replace('_wool', '_bed'), 1, t)) {
    const b = items().find(i => i.name.endsWith('_bed'))
    if (b) await placeNear(b.name)
  }
  return true
}

// ================= VÒNG LẶP SINH TỒN =================
const pickTier = () => has('iron_pickaxe') ? 3 : has('stone_pickaxe') ? 2 : has('wooden_pickaxe') ? 1 : 0
const isLog = b => b && b.name.endsWith('_log')

async function step() {
  await eatIfHungry(14)
  if (await tryBed()) return

  // thiếu đồ ăn -> đi săn rồi nấu
  if (foodCount() < 3 && pickTier() >= 1) {
    await hunt(['cow', 'pig', 'sheep', 'chicken'], 3)
    await cookAll()
    return
  }

  // 1. gỗ -> bàn craft -> cuốc gỗ
  if (pickTier() === 0) {
    if (logsCount() + Math.floor(planksCount() / 4) < 4) { await collect(isLog, 5, 64); return }
    const t = await getTable()
    if (!t) return
    await ensurePlanks(5)
    if (countName('stick') < 2) await craft('stick', 1)
    await craft('wooden_pickaxe', 1, t)
    return
  }

  // 2. giường (để ngủ đêm)
  if (!bedBlock() && !items().some(i => i.name.endsWith('_bed')) && pickTier() >= 1) {
    if (logsCount() < 2 && planksCount() < 3) { await collect(isLog, 3, 64); return }
    await getBed()
    // nếu thất bại vẫn đi tiếp giai đoạn sau, tránh kẹt
  }

  // 3. đá -> đồ đá + lò
  if (pickTier() < 2) {
    if (countName('cobblestone') < 20) { await collect(is(['stone']), 20 - countName('cobblestone'), 48); return }
    if (logsCount() + planksCount() < 6) { await collect(isLog, 3, 64); return }
    const t = await getTable()
    if (!t) return
    await ensurePlanks(4)
    if (countName('stick') < 4) await craft('stick', 2)
    await craft('stone_pickaxe', 1, t)
    if (!items().some(i => i.name === 'stone_sword')) await craft('stone_sword', 1, t)
    if (!items().some(i => i.name === 'stone_axe')) await craft('stone_axe', 1, t)
    return
  }

  // 4. than + sắt
  const ironHave = () => countName('raw_iron') + countName('iron_ingot')
  if (pickTier() < 3) {
    if (countFn(n => n === 'coal' || n === 'charcoal') < 3) { await mineOre(['coal_ore', 'deepslate_coal_ore'], 3); return }
    if (ironHave() < 5) { await mineOre(['iron_ore', 'deepslate_iron_ore'], 5 - ironHave()); return }
    if (countName('raw_iron') > 0) { await smelt('raw_iron', countName('raw_iron')); return }
    if (countName('iron_ingot') >= 3) {
      const t = await getTable()
      if (!t) return
      if (countName('stick') < 4) { await ensurePlanks(2); await craft('stick', 1) }
      await craft('iron_pickaxe', 1, t)
      if (countName('iron_ingot') >= 2) await craft('iron_sword', 1, t)
      return
    }
    return
  }

  // 5. xong -> chuyển sang đi theo người chơi gần nhất
  log('hoàn thành giai đoạn sinh tồn')
  survive = false
  const near = Object.values(bot.players).find(p => p.entity && p.username !== bot.username)
  if (near) followPlayer(near.username)
}

async function survivalLoop() {
  bot.chat('Bắt đầu sinh tồn!')
  while (survive) {
    try { await step() } catch (e) { log('lỗi step:', e.message); await sleep(2000) }
    await sleep(500)
  }
}

function startSurvive() {
  if (survive) return
  followTarget = null
  bot.pathfinder.setGoal(null)
  survive = true
  survivalLoop()
}
function stopSurvive() { survive = false; bot.pathfinder.setGoal(null) }

// ================= ĐÁNH QUÁI + TRỘM RƯƠNG =================
function fightNearby() {
  const mob = bot.nearestEntity(e => e.type === 'hostile' && e.position.distanceTo(bot.entity.position) < 4)
  if (!mob) return
  const sword = items().find(i => i.name.endsWith('_sword'))
  if (sword && !busy) bot.equip(sword, 'hand').catch(() => {})
  bot.attack(mob)
}

function allowed(item) {
  if (CONFIG.stealBlacklist.some(b => item.name.includes(b))) return false
  return CONFIG.stealWhitelist.length === 0 || CONFIG.stealWhitelist.includes(item.name)
}

async function trySteal(force = false) {
  if (busy) return
  if (!force && Date.now() - lastSteal < CONFIG.stealCooldownMs) return
  const chestBlock = bot.findBlock({
    matching: b => ['chest', 'trapped_chest', 'barrel'].includes(b.name),
    maxDistance: CONFIG.chestRange
  })
  if (!chestBlock) return
  busy = true
  try {
    const win = await bot.openContainer(chestBlock)
    let taken = 0
    for (const item of win.containerItems()) {
      if (taken >= CONFIG.stealMaxItems) break
      if (!allowed(item)) continue
      const count = Math.min(item.count, 4)
      await win.withdraw(item.type, item.metadata, count)
      taken++
      const c = chestBlock.position
      log(`[STEAL] ${new Date().toISOString()} ${item.name} x${count} @ ${c.x} ${c.y} ${c.z}`)
    }
    win.close()
    if (taken > 0) lastSteal = Date.now()
  } catch (e) { log('Lỗi mở rương:', e.message) }
  finally { busy = false }
}

setInterval(() => {
  if (!bot || !bot.entity || !mcData) return
  fightNearby()
  if (!survive) {
    eatIfHungry(14)
    if (followTarget) trySteal()
  }
}, 1000)

startBot()
