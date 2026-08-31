# my_scripts

Personal browser userscripts plus compatibility pointers for CLI integrations that now live in dedicated repositories.

## Active projects

| Category | Project | Canonical location |
| --- | --- | --- |
| Browser userscript | ChatGPT Recent Turns | This repository: `chatgpt-recent-turns.user.js` + `chatgpt-recent-turns.meta.js` |
| Codex CLI hook | Auto Thread Title | https://github.com/nonlog/codex-auto-thread-title |
| Windows CLI integration | Completion notifications for Codex / Claude Code / Pi | https://github.com/nonlog/windows-cli-notify |
| Pi extension | Auto Session Title | https://github.com/nonlog/pi-auto-session-title |
| Claude Code title hook | Retired; use Claude Code built-in auto-title | `docs/retired/claude-auto-session-title.md` |

## Repository layout

```text
my_scripts/
â”œâ”€ chatgpt-recent-turns.user.js       # stable ScriptCat download endpoint
â”œâ”€ chatgpt-recent-turns.meta.js       # stable ScriptCat update endpoint
â”œâ”€ userscripts/
â”‚  â””â”€ chatgpt-recent-turns/README.md  # userscript documentation¸¥'8¥ ØÜËÂ¸¥ ˆ8¥%8¥ ™]\™YÈÈ\İÜšXØ[ÛZYÜ˜][Ûˆ›İ\Â¸¥%8¥ ÛÓH]Ï‹Ô‘PQQK›YÈÛÛ\]Xš[]HÚ[\œÈÛ›B˜‚•HÛÈÚ]Ô\Ù\œØÜš\š[\È[[[Û˜[H™[XZ[ˆ]H™\ÜÚ]ÜH›Ûİ™XØ]\ÙH^\İ[™ÈØÜš\Ø][œİ[][ÛœÈ[™XYH\ÙHÜÙH˜]ÈÚ]XˆT“Ëˆ[İš[™È[HÛİ[œ™XZÈ™[[İH\]\È›Üˆ[œİ[YÛY[Ë‚‚ˆÈÈÓH[YÜ˜][ÛœÂ‚‘^Xİ]X›HÓHÛÚËÙ^[œÚ[ÛˆÛÙH\È›ÈÛ™Ù\ˆ\XØ]Y\™KˆXXÚXZ[Z[™Y[YÜ˜][Ûˆ\È]ÈİÛˆ™\ÜÚ]ÜK\İË™[X\ÙH\İÜK[™[œİ[][Ûˆ[œİXİ[ÛœÎ‚‚‹H
ŠÛÙ^]]È]NŠŠˆ›Û›ÙËØÛÙ^X]]Ë]™XY]]X‹H
Š•Ú[™İÜÈÛÛ\][Ûˆ›İYšXØ][ÛœÎŠŠˆ›Û›ÙËİÚ[™İÜËXÛK[›İYX‹H
Š”H]]È]NŠŠˆ›Û›ÙËÜKX]]Ë\Ù\ÜÚ[Û‹]]X‚•H™]š[İ\ÈÛÙ^X]]Ë]™XY]]KØÛKZÛÚÜËİÚ[™İÜË[›İYKØ[™KX]]Ë\Ù\ÜÚ[Û‹]]KØ]È\™H™]Z[™Y\ÈÛX[ZYÜ˜][ÛˆİXœÈÛÈÛ›ÛÚÛX\šÜÈ[™Øİ[Y[][ÛˆÈ›İ™XÛÛYHXY[™Ë‚‚ˆÈÈÚ]Ô™XÙ[\›œÂ‚”ÙYHØ\Ù\œØÜš\ËØÚ]Ü\™XÙ[]\›œËÔ‘PQQK›YJ\Ù\œØÜš\ËØÚ]Ü\™XÙ[]\›œËÔ‘PQQK›Y
H›Üˆ™Z]š[Ü‹ÛÛ›ÛËØÜš\Ø][œİ[][Û‹\˜›È]Z[Ë[™[Z]][ÛœË‚‚Ø[›ÛšXØ[ØÜš\Ø][™Ú[È™[XZ[‚‚˜^šÎ‹ËÜ˜]Ë™Ú]X\Ù\˜ÛÛ[˜ÛÛKÛ›Û›ÙËÛ^WÜØÜš\ËÛX\İ\‹ØÚ]Ü\™XÙ[]\›œË›Y]KšœÂšÎ‹ËÜ˜]Ë™Ú]X\Ù\˜ÛÛ[˜ÛÛKÛ›Û›ÙËÛ^WÜØÜš\ËÛX\İ\‹ØÚ]Ü\™XÙ[]\›œË\Ù\‹šœÂ˜