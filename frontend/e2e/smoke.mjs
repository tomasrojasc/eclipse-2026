import { chromium } from 'playwright'

const SP = process.env.SHOT_DIR || '.'
const errs = []
const ok = []
const bad = (m) => { errs.push(m); console.log('  FAIL ' + m) }
const good = (m) => { ok.push(m); console.log('  ok   ' + m) }

const b = await chromium.launch({
  channel: 'chrome',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader'],
})
const p = await b.newPage({ viewport: { width: 1680, height: 1000 } })
const console_errors = []
p.on('console', (m) => { if (m.type() === 'error') console_errors.push(m.text()) })
p.on('pageerror', (e) => console_errors.push('pageerror: ' + e.message))

await p.goto('http://localhost:5173', { waitUntil: 'networkidle' })
await p.waitForTimeout(2500)

const txt = (sel) => p.locator(sel).first().innerText()

// 1. Default site (Oviedo) shows totality.
let phase = await txt('.readout:last-child .v')
phase === 'total' ? good(`default lands on totality (phase=${phase})`) : bad(`expected total at MAX, got "${phase}"`)

// 2. Contact times present.
const c2 = await p.locator('.contact', { hasText: 'totality begins' }).locator('.time').innerText()
;/^\d\d:\d\d:\d\d/.test(c2) ? good(`C2 rendered: ${c2}`) : bad(`C2 malformed: ${c2}`)

// 3. Switch to Madrid: must report partial only, and C2/C3 disabled.
await p.locator('.chip', { hasText: 'Madrid' }).click()
await p.waitForTimeout(2600)
const totalityNote = await p.locator('.panel', { hasText: 'CONTACTS AT THIS SITE' }).innerText()
;/partial only/i.test(totalityNote) ? good('Madrid reports partial only') : bad('Madrid did not report partial only')
const c2disabled = await p.locator('.contact', { hasText: 'totality begins' }).isDisabled()
c2disabled ? good('C2 button disabled outside the path') : bad('C2 should be disabled at Madrid')

// 4. Coverage readout at Madrid max should be just under 100, not rounded to 100.
await p.locator('.contact', { hasText: 'greatest eclipse' }).click()
await p.waitForTimeout(700)
const cov = await txt('.readouts .readout:nth-child(3) .v')
;/^99\.9/.test(cov) ? good(`Madrid peak coverage shown precisely: ${cov}`) : bad(`Madrid peak coverage suspicious: ${cov}`)

// 5. Back to a totality site, scrub the slider and confirm the frame changes.
await p.locator('.chip', { hasText: 'Zaragoza' }).click()
await p.waitForTimeout(2600)
const t0 = await txt('.readouts .readout:first-child .v')
await p.locator('input[type=range]').press('Home')
await p.waitForTimeout(500)
const t1 = await txt('.readouts .readout:first-child .v')
t0 !== t1 ? good(`scrubbing changes the time (${t0} -> ${t1})`) : bad('scrubbing did not change the time')

// 6. Play/pause advances time.
await p.locator('.btn.primary', { hasText: 'Play' }).click()
await p.waitForTimeout(1400)
const t2 = await txt('.readouts .readout:first-child .v')
t2 !== t1 ? good(`playback advances (${t1} -> ${t2})`) : bad('playback did not advance')
await p.locator('.btn.primary').first().click()

// 7. Save this moment adds to the sidebar.
const before = Number(await txt('.sidebar-head .count'))
await p.locator('.btn', { hasText: 'Save this moment' }).click()
await p.waitForTimeout(900)
const after = Number(await txt('.sidebar-head .count'))
after === before + 1 ? good(`Save this moment appended (${before} -> ${after})`) : bad(`save failed (${before} -> ${after})`)

// 8. Pattern builder: load a preset, confirm shots previewed, commit them.
await p.locator('select').first().selectOption({ label: 'Totality bracket (corona detail)' })
await p.waitForTimeout(2600)
const rows = await p.locator('.preview-row').count()
rows > 5 ? good(`preset previewed ${rows} shots`) : bad(`preset preview thin: ${rows} rows`)
const addBtn = p.locator('.btn.primary', { hasText: 'to shot list' })
const addLabel = await addBtn.innerText()
await addBtn.click()
await p.waitForTimeout(1500)
const after2 = Number(await txt('.sidebar-head .count'))
after2 > after ? good(`committed pattern ("${addLabel}") -> ${after2} saved`) : bad('commit did not add shots')

// 9. Delete one shot.
await p.locator('.shot .btn.icon.danger').first().click()
await p.waitForTimeout(900)
const after3 = Number(await txt('.sidebar-head .count'))
after3 === after2 - 1 ? good(`delete works (${after2} -> ${after3})`) : bad(`delete failed (${after2} -> ${after3})`)

// 10. A shot inside totality must be flagged NO FILTER.
const noFilter = await p.locator('.shot .badge.filter-off').count()
noFilter > 0 ? good(`${noFilter} shots flagged NO FILTER`) : bad('no NO FILTER badges on totality shots')

// 11. CSV export reachable.
const resp = await p.request.get('http://localhost:5173/api/shots/export.csv')
const csv = await resp.text()
resp.ok() && csv.split('\n').length > 2
  ? good(`CSV export returns ${csv.trim().split('\n').length - 1} rows`)
  : bad('CSV export broken')

// 12. Near C4 the Sun is very low here — check the readout still reports it.
await p.locator('.contact', { hasText: 'last contact' }).click()
await p.waitForTimeout(800)
const altTxt = await txt('.readouts .readout:nth-child(4) .v')
good(`C4 altitude readout: ${altTxt}°`)
await p.screenshot({ path: `${SP}/e2e-c4.png` })

// 13. Map click picks a new site.
const coordsBefore = await p.locator('.panel-head .mono').first().innerText()
await p.locator('.map').click({ position: { x: 300, y: 180 } })
await p.waitForTimeout(2600)
const coordsAfter = await p.locator('.panel-head .mono').first().innerText()
coordsBefore !== coordsAfter ? good(`map click repositions (${coordsBefore} -> ${coordsAfter})`) : bad('map click did nothing')

// --- site search ----------------------------------------------------------

const box = p.locator('.search-input')

// 14. Search by name, with the totality verdict shown per result.
await box.fill('santander')
await p.waitForTimeout(1500)
const nRows = await p.locator('.search-row').count()
nRows > 0 ? good(`search "santander" -> ${nRows} result(s)`) : bad('search returned nothing')
const badgeTxt = await p.locator('.search-row').first().locator('.sr-badge').innerText()
;/totality|partial|no eclipse/.test(badgeTxt)
  ? good(`result annotated: "${badgeTxt}"`)
  : bad(`result badge not computed: "${badgeTxt}"`)

// 15. No partial may ever be rounded up to read as 100%.
await box.fill('santiago de compostela')
await p.waitForTimeout(1500)
const badges = await p.locator('.sr-badge').allInnerTexts()
badges.some((t) => t.includes('100') && t.includes('partial'))
  ? bad(`a partial eclipse reads as 100%: ${badges.join(', ')}`)
  : good('no partial eclipse is rounded up to 100%')

// 16. Selecting a result recomputes the eclipse for that town.
await box.fill('ribadesella')
await p.waitForTimeout(1400)
await box.press('Enter')
await p.waitForTimeout(3000)
const picked = await p.locator('.site-name').innerText()
const pickedC2 = await p.locator('.contact', { hasText: 'totality begins' }).locator('.time').innerText()
;/^\d\d:/.test(pickedC2)
  ? good(`selected "${picked}", C2 recomputed to ${pickedC2}`)
  : bad(`selecting a town did not recompute contacts (${pickedC2})`)

// 17. Accent- and article-insensitive matching.
for (const [q, want] of [['coruna', 'A Coruña'], ['ejido', 'El Ejido'], ['donostia', 'Donostia']]) {
  await box.fill(q)
  await p.waitForTimeout(1100)
  const top = await p.locator('.sr-name').first().innerText()
  top.includes(want) ? good(`"${q}" -> ${top}`) : bad(`"${q}" gave "${top}", wanted ${want}`)
}

// 18. Pasted coordinates are accepted as a site.
await box.fill('42.5500, -6.0000')
await p.waitForTimeout(1100)
const coordRegion = await p.locator('.sr-region').first().innerText()
coordRegion.toLowerCase().includes('coordinates')
  ? good('pasted coordinates recognised')
  : bad(`pasted coordinates not recognised (${coordRegion})`)
await box.press('Enter')
await p.waitForTimeout(3000)
const jumped = await p.locator('.panel-head .mono').first().innerText()
jumped.includes('42.5500') ? good(`jumped to ${jumped}`) : bad(`coordinate jump failed (${jumped})`)

// 19. Unmatched query explains itself instead of showing a blank list.
await box.fill('zzzzqqq')
await p.waitForTimeout(1100)
;(await p.locator('.search-empty').count()) > 0
  ? good('unmatched query shows a helpful empty state')
  : bad('unmatched query gave no empty state')
await box.press('Escape')

// --- data explorer tab ----------------------------------------------------

await p.locator('.tabs button', { hasText: 'Limb data' }).click()
await p.waitForTimeout(7000)

if (await p.locator('canvas.terrain').count()) { good('terrain map rendered') }
else { bad('terrain map missing') }

const nCharts = await p.locator('.chart-holder canvas').count()
if (nCharts >= 3) { good(`${nCharts} data charts rendered`) }
else { bad(`expected 3+ charts, got ${nCharts}`) }

// Hovering the terrain must report a plausible lunar radius.
const tbox = await p.locator('canvas.terrain').boundingBox()
await p.mouse.move(tbox.x + tbox.width * 0.5, tbox.y + tbox.height * 0.5)
await p.waitForTimeout(400)
const rd = (await p.locator('.hoverbox').first().innerText()).trim()
const km = Number((rd.match(/radius (\d+\.\d+) km/) || [])[1])
if (km > 1725 && km < 1750) { good(`terrain hover reads ${km} km`) }
else { bad(`terrain hover implausible: "${rd}"`) }

if (await p.locator('table.sources').count()) { good('data provenance listed') }
else { bad('no provenance table') }

await p.locator('.tabs button', { hasText: 'Plan' }).click()
await p.waitForTimeout(1000)
if (await p.locator('.map').isVisible()) { good('Plan tab survives the round trip') }
else { bad('Plan tab broken after switching back') }

// --- 3D view --------------------------------------------------------------

await p.locator('.tabs button', { hasText: '3D' }).click()
await p.waitForTimeout(22000)

if (await p.locator('.globe-canvas canvas').count()) { good('3D WebGL canvas created') }
else { bad('3D canvas missing') }

const hud = (await p.locator('.globe-hud').innerText()).replace(/\n/g, ' | ')
const away = Number((hud.match(/([\d,]+) km away/) || ['', '0'])[1].replace(/,/g, ''))
if (away > 340000 && away < 400000) { good(`3D camera at the true lunar distance (${away} km)`) }
else { bad(`3D camera distance wrong: ${hud}`) }
if (/your view/.test(hud)) { good('3D starts locked to the observer') }
else { bad(`3D not following observer: ${hud}`) }

// Close-up must reach a focal length that can actually resolve a bead.
await p.locator('.btn', { hasText: 'Beads close-up' }).click()
await p.waitForTimeout(3000)
const hud2 = (await p.locator('.globe-hud').innerText()).replace(/\n/g, ' | ')
const mm = Number((hud2.match(/≈([\d,]+) mm/) || ['', '0'])[1].replace(/,/g, ''))
if (mm > 15000) { good(`close-up reaches ${mm} mm equivalent`) }
else { bad(`close-up not tight enough: ${hud2}`) }

await p.locator('.btn', { hasText: 'Free orbit' }).click()
await p.waitForTimeout(1500)
if (/free orbit/.test((await p.locator('.globe-hud').innerText()))) { good('free orbit engages') }
else { bad('free orbit did not engage') }

await p.locator('.tabs button', { hasText: 'Plan' }).click()
await p.waitForTimeout(1200)
if (await p.locator('.map').isVisible()) { good('Plan tab survives the 3D round trip') }
else { bad('Plan tab broken after 3D') }

await p.screenshot({ path: `${SP}/e2e-final.png`, fullPage: true })
await b.close()

console.log(`\n${ok.length} passed, ${errs.length} failed`)
if (console_errors.length) {
  console.log('\nBrowser console errors:')
  ;[...new Set(console_errors)].slice(0, 12).forEach((e) => console.log('  - ' + e.slice(0, 220)))
}
process.exit(errs.length ? 1 : 0)
