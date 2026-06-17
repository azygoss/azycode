# Azycode Geliştirme Planı

## 1. Proje Özeti

Azycode, bağımsız (dependency-free) bir AI kodlama CLI aracıdır. 51 kaynak modülü, ~17.500 satır JS kodu ve 50 test dosyası (~6.800 satır) ile orta-ölçekli, mimari olarak zengin bir projedir. COMPLETION_AUDIT.md'e göre çoğu temel özellik tamamlanmış durumdadır, ancak mimari, güvenlik, test kapsamı ve performans alanlarında önemli geliştirme fırsatları mevcuttur.

---

## 2. Geliştirme Alanları ve Öncelikler

### 🔴 P0 — Kritik (Güvenlik & Mimari)

#### 2.1 Güvenlik Katmanı Güçlendirme

**A) Path Traversal Koruması (path-guard.js)**
- **Sorun:** Symlink traversal saldırısı mümkün (`ln -s /etc/passwd etc-passwd` → `write_file`)
- **Sorun:** `./.git/config` prefix bypass (`^\.git` regex eşleşmez)
- **Eylem:** `fs.realpathSync` ile symlink çözümlemesi ekle
- **Eylem:** `path.normalize` + `startsWith(root)` kontrolü uygula

**B) Patch Validation Entegrasyonu (patch-validation.js + path-guard.js)**
- **Sorun:** `assertPatchPathsAllowed` hiç çağrılmıyor
- **Sorun:** `runPatchChecks` içinde shell-risk.js entegrasyonu yok
- **Eylem:** `validatePatch` içinde `assertPatchPathsAllowed` çağrısı ekle
- **Eylem:** `runPatchChecks` için `evaluateShellPolicy` kontrolü ekle

**C) Shell Risk Redirection (shell-risk.js)**
- **Sorun:** `cat > /etc/passwd` gibi redirection'lar yakalanmıyor
- **Sorun:** `>`, `<`, `>>`, `|` operatörleri kontrol dışı
- **Eylem:** Pipeline segment ayrıştırması ekle
- **Eylem:** Redirection operatörleri için risk sınıflandırması ekle

**D) MCP Güvenliği (mcp.js)**
- **Sorun:** MCP server `command` doğrulanmıyor
- **Sorun:** `LD_PRELOAD`, `PATH` manipulation mümkün
- **Sorun:** Timeout sonrası process zombi kalıyor
- **Eylem:** `command` path doğrulaması ekle
- **Eylem:** `server.env` filtrelemesi (`LD_PRELOAD` engelle)
- **Eylem:** `SIGTERM` + `SIGKILL` fallback ekle

**E) Subagent Güvenliği (subagents.js)**
- **Sorun:** `alwaysApprove: true` privilege escalation
- **Sorun:** `subagentDepth` artırılmadan recursive çağrı
- **Eylem:** `alwaysApprove` kaldır, ana agent permission profiline uy
- **Eylem:** `subagentDepth + 1` geçişini garantile

#### 2.2 Mimari Düzeltmeler

**A) `sandbox.js` Eksikliği**
- **Sorun:** ARCHITECTURE.md'de listelenen `sandbox.js` dosyası yok, `execution-policy.js` sandbox mantığını içeriyor
- **Eylem:** Ya `sandbox.js` oluştur ve `execution-policy.js`'ten ayır, ya da ARCHITECTURE.md güncelle

**B) `guard.js` İsim Çakışması**
- **Sorun:** `guard.js` (git guard) ile `path-guard.js` isimleri benzer, kafa karıştırıcı
- **Eylem:** `guard.js` → `git-guard.js` olarak yeniden adlandır

**C) `applyPermissionProfile` Çift Export**
- **Sorun:** Hem `config.js` hem `permissions.js` içinde var
- **Eylem:** Tek kaynak olarak `permissions.js`'te tut, `config.js`'ten kaldır

---

### 🟠 P1 — Yüksek (Mimari Refaktör & Test Kapsamı)

#### 2.3 TUI Modül Bölünmesi (tui.js)

**Durum:** `tui.js` 2150 satır, 8 farklı sorumluluk içeriyor.

**Hedef:** Command Pattern uygulayarak modülü böl

```
src/tui/
  ├── index.js          # launchTui() + input döngüsü
  ├── commands.js       # handleCommand() + 30+ komut handler (Command Registry)
  ├── agent-runner.js   # askAgent() + spinner/stream yönetimi
  ├── select.js         # selectFromList() + readSecret()
  ├── composer.js       # createComposerRenderer() + composer pane
  └── commands/         # Her komut için ayrı handler dosyası
      ├── model.js
      ├── mission.js
      ├── config.js
      └── ...
```

**Somut İlk Adımlar:**
1. `handleCommand` devasa if-else zincirini `{ name, handler, args }` kayıt sistemine dönüştür
2. `askAgent` fonksiyonunu `AgentRunner` sınıfına çıkar (spinner, streamPanel, cost tracking)
3. `selectFromList` raw mode yönetimini `try/finally` ile garantile

#### 2.4 UI Modül Katmanlı Yapı (ui.js)

**Durum:** `ui.js` 1915 satır, hem "piksel" seviyesi ANSI fonksiyonu hem business logic içeriyor.

**Hedef:** Katmanlı yapıya dönüştür

```
src/ui/
  ├── ansi.js      # style, paint, truncate, wrapText, visibleLength
  ├── layout.js    # box, frame, panel, rule, align
  ├── components.js # errorPanel, sessionCard, toolCard, welcomeScreen
  └── cost.js      # MODEL_PRICING, estimateCost (business logic)
```

**Somut İlk Adımlar:**
1. `MODEL_PRICING` ve `estimateCost` → `src/cost.js` veya `src/pricing.js`
2. `modeColor` gibi ortak fonksiyonlar → `src/ui/ansi.js` (tek kaynak)
3. `console.log` side-effect'lerini temizle: `title()`, `section()` fonksiyonları `string[]` döndürsün
4. `highlightTerms` sadece ilk eşleşmeyi vurguluyor → global replace kullan

#### 2.5 Test Kapsamı Artırımı

**Hedef:** %65 → %90+ satır kapsamı

**Öncelikli Eksik Testler:**

| Modül | Öncelik | Eksik Senaryolar |
|-------|---------|------------------|
| `context.js` | 🔴 Kritik | repoSnapshot (10K+ dosya, monorepo, boş repo), contextPack (symlink, döngüsel import), cache invalidation |
| `agent.js` | 🔴 Kritik | Unit test (şu an sadece E2E), maxSteps limit, invalid tool name, provider 500 error |
| `cli.js` | 🟠 Yüksek | Network timeout, bozuk config.json, provider failure, streaming output |
| `terminal-input.js` | 🟠 Yüksek | TTY olmayan ortam, key kombinasyonları |
| `model-sync.js` | 🟠 Yüksek | 401/403/500 hata kodları, model migration |
| `agent-errors.js` | 🟡 Orta | Error serialization, report generation |
| `prompt.js` | 🟡 Orta | Template rendering, escaping, injection |
| `memory.js` | 🟡 Orta | Add/search/remove, limit handling, persistence |
| `provider-errors.js` | 🟡 Orta | Error formatting, retry classification |

**Test Yardımcıları (test/helpers/):**
- `withIsolatedHome()` — AZYCODE_HOME izolasyonu
- `mockLlmServer()` — LLM mock'ları merkezileştirme
- `setupGitRepo()` — Git repo setup'u

#### 2.6 DRY İhlalleri Düzeltme

- `modeColor` hem `ui.js` hem `tui.js` içinde → tek kaynak
- ANSI escape state machine `truncate()`, `sliceVisible()`, `skipVisible()` içinde tekrar ediyor → `ansiWalk()` iterator fonksiyonu
- `palettePanel` ile `helpPanel` neredeyse aynı kod → `renderCommandList()` yardımcı fonksiyonu

---

### 🟡 P2 — Orta (Performans & İyileştirmeler)

#### 2.7 Performans Optimizasyonları

**A) Context Pack (context.js)**
- `listFiles()` 300 dosya limiti sabit kodlanmış → konfigüre edilebilir hale getir
- `walk()` recursive senkron çağrı → async iterator kullanarak non-blocking hale getir
- Büyük repo (10K+ dosya) için performans testi ekle
- `fileMtime()` her çağrıda `fs.statSync` → cache kullan

**B) TUI Spinner/Stream Senkronizasyonu**
- `spinner` ve `streamPanel` aynı anda aktif olabilir → race condition
- `AgentUIManager` sınıfı oluştur: `start()`, `stop()`, `transitionToStream()` metodları

**C) Config Cache Race Condition**
- `saveConfig` tmp yolu `${configPath()}.${process.pid}.tmp` → aynı process'te paralel write çakışır
- `crypto.randomBytes` ile tmp dosya adı kullan

**D) LLM Stream Buffer**
- `openaiChatStream` buffer yönetimi basit → `TransformStream` veya `ReadableStream` kullanarak daha robust hale getir

#### 2.8 Local Review Heuristic Genişletme

**A) Config Detection Bug (local-review.js)**
- `scanFiles` içinde `config.json` kontrolü file path'te arıyor, content'te değil
- `/.azycode\/config\.json$/.test(file)` → content kontrolüne taşı

**B) Secret Detection Eksikliği**
- `password=`, `secret=`, `token=`, `AWS_ACCESS_KEY_ID=AKIA`, `GITHUB_TOKEN=ghp_`, `PRIVATE_KEY=` pattern'leri ekle

**C) SSRF Detection Eksikliği**
- `axios`, `http.request`, `node-fetch`, `urllib`, `request` kütüphanelerini tespit et

**D) Path Traversal Detection**
- `fs.readFileSync(userInput)` gibi pattern'leri tespit et

#### 2.9 Execution Policy İyileştirmeleri

**A) Container Mount Validasyonu**
- `buildContainerArgs` içinde `mount.source`/`mount.target` doğrulaması ekle
- `/var/run/docker.sock`, `/proc`, `/sys`, `/dev` mount'larını engelle

**B) Windows PowerShell**
- `-ExecutionPolicy Bypass` yerine `-ExecutionPolicy RemoteSigned` kullan

**C) Fallback Bildirimi**
- Sandbox → local düşüşü kullanıcıya bildir

---

### 🟢 P3 — Düşük (Dokümantasyon & UX)

#### 2.10 Dokümantasyon

- **JSDoc:** Hiçbir modülde JSDoc yok. En azından public API fonksiyonları için JSDoc ekle
- **API Dokümanı:** `docs/API.md` oluştur, modüllerin public API'larını listele
- **Migration Guide:** Eski `azy-code` kullanıcıları için migration rehberi
- **Troubleshooting:** `docs/TROUBLESHOOTING.md` — yaygın hatalar ve çözümler

#### 2.11 Kullanıcı Deneyimi

**A) TUI Hata Yönetimi**
- `gitSummary` catch bloğu boş → en azından `debug` modda logla
- `selectFromList` raw mode cleanup → `try/finally` garantisi

**B) Hata Mesajları**
- Daha spesifik hata mesajları (örn: "No active provider" yerine "No active provider: run 'azycode login <provider>'")
- Error chaining ve `cause` property kullanımı

**C) Recovery Mekanizmaları**
- Bozuk `config.json` için otomatik backup ve recovery
- `azycode doctor` daha kapsamlı teşhis (disk space, network, git status)

#### 2.12 Örnek ve Template Genişletme

- `examples/` dizini sadece 1 `mission.yml` içeriyor
- Ekle: `examples/skills/`, `examples/commands/`, `examples/missions/`, `examples/subagents/`
- Ekle: `examples/README.md` — her örneğin açıklaması

---

## 3. Uygulama Planı (Fazlar)

### Faz 1: Güvenlik Temeli (Hafta 1-2)
1. Path traversal symlink koruması (`path-guard.js`)
2. Patch validation entegrasyonu (`patch-validation.js` + `path-guard.js`)
3. Shell risk redirection coverage (`shell-risk.js`)
4. MCP server command validation + env filtreleme (`mcp.js`)
5. Subagent alwaysApprove kaldırma + recursive depth fix (`subagents.js`)
6. `sandbox.js` / `execution-policy.js` tutarlılığı çöz

**Çıktı:** Güvenlik temeli sağlam, 5 kritik açık kapatılmış

### Faz 2: Test Kapsamı ve Mimari Refaktör (Hafta 3-4)
1. `context.js` test suit yazımı (~2-3 gün)
2. `agent.js` unit testleri (~1-2 gün)
3. `cli.js` ek E2E testleri (~1-2 gün)
4. Test yardımcıları merkezileştirme (`test/helpers/`) (~1 gün)
5. TUI modül bölünmesi başlangıcı (`src/tui/commands.js`) (~2-3 gün)
6. UI modül katmanlı yapıya dönüşüm (`src/ui/`) (~2-3 gün)

**Çıktı:** %90+ test kapsamı, TUI/UI modülleri bölünmüş

### Faz 3: Performans ve İyileştirmeler (Hafta 5-6)
1. Context pack async walk ve cache iyileştirmeleri
2. TUI spinner/stream senkronizasyonu (`AgentUIManager`)
3. Config cache race condition düzeltme
4. Local review heuristic genişletme (secret, SSRF, path traversal)
5. Execution policy container mount validasyonu

**Çıktı:** Daha hızlı context pack, daha güvenli shell, daha robust TUI

### Faz 4: Dokümantasyon ve UX (Hafta 7)
1. JSDoc ekleme (public API fonksiyonları)
2. `docs/API.md` ve `docs/TROUBLESHOOTING.md` oluşturma
3. `examples/` dizini genişletme
4. Hata mesajları iyileştirme
5. `azycode doctor` teşhis genişletme

**Çıktı:** Kapsamlı dokümantasyon, daha iyi UX, daha fazla örnek

---

## 4. Kalite Metrikleri ve Hedefler

| Metrik | Mevcut | Hedef | Takip Aracı |
|--------|--------|-------|-------------|
| Test kapsamı | ~%65 | %90+ | `node --test` + coverage reporter |
| Kritik güvenlik açığı | 5 | 0 | Güvenlik audit checklist |
| Mimari tutarlılık sorunu | 7 | 0 | ARCHITECTURE.md senkronizasyonu |
| DRY ihlali | 8+ | 0 | Kod tekrarı tarama |
| JSDoc coverage | %0 | %50+ | JSDoc tarama |
| Örnek/template | 1 | 10+ | `examples/` dizini sayımı |
| Ortalama modül satırı | ~340 | <200 | `wc -l src/*.js` |

---

## 5. Riskler ve Mitigasyonlar

| Risk | Olasılık | Etki | Mitigasyon |
|------|----------|------|------------|
| TUI/UI refaktörü regression | Orta | Yüksek | Faz 2'de test kapsamı önce artırılır, her adımda test çalıştırılır |
| Güvenlik fix'leri breaking change | Düşük | Yüksek | Migration guide yazılır, changelog'da belirtilir |
| context.js testleri uzun sürer | Yüksek | Orta | Paralel yazım, mock kullanımı, fixture'lar |
| MCP güvenlik fix'leri MCP server'ları bozar | Orta | Orta | Kapsamlı MCP test suiti önce yazılır |
| Subagent alwaysApprove kaldırma kullanıcıları etkiler | Orta | Düşük | Deprecation notice + config migration |

---

## 6. Sonuç

Azycode, sağlam bir temel üzerine kurulmuş, iyi düşünülmüş bir AI kodlama CLI aracıdır. COMPLETION_AUDIT.md'e göre çoğu temel özellik tamamlanmıştır. Ancak:

1. **Güvenlik:** 5 kritik açık (path traversal, patch validation, shell risk, MCP, subagent) hemen düzeltilmelidir.
2. **Mimari:** `tui.js` (2150 satır) ve `ui.js` (1915 satır) modüllerinin bölünmesi uzun vadeli bakılabilirliği sağlar.
3. **Test:** `context.js` (639 satır, test yok) ve `agent.js` (sadece E2E) kapsamlı testlerle güvenli hale getirilmelidir.
4. **Performans:** Context pack büyük repo'lar için optimize edilmelidir.
5. **Dokümantasyon:** JSDoc ve kullanıcı rehberleri eksiktir.

Bu planın uygulanmasıyla Azycode, hem daha güvenli hem daha bakılabilir hem de daha iyi test edilmiş bir proje haline gelecektir.
