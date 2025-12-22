Proje Tanımı

Bu proje, voice-first (ses odaklı) terapi/koçluk deneyimi sunan bir backend servisidir. Mobil istemci (iOS/Android), kullanıcıdan ses alır; backend bu sesi STT (speech-to-text) ile yazıya çevirir; konuşma geçmişi ve önceki seans özetleriyle birlikte LLM’e (OpenAI) gönderir; LLM’den gelen yanıtı TTS (text-to-speech) ile tekrar sese çevirip mobile döndürür. Amaç: kullanıcıyla “yazışma gibi değil”, “konuşma gibi” ilerleyen bir koçluk/terapi akışı yaratmaktır.

Servis ayrıca:
	•	Client (danışan) oluşturma/güncelleme,
	•	Terapist listesi ve ses örneği,
	•	Seans (session) oluşturma,
	•	Seans bitirme ve seans özeti üretme,
	•	Seans özetini getirme (MD/HTML),
	•	Client’ın seanslarını listeleme,
	•	Admin test endpoint’leri (trial reset/expired gibi)
sağlar.

Önemli tasarım hedefleri:
	•	Backwards compatible: Eski mobil sürümler patlamamalı.
	•	Multi-language ready: Varsayılan TR olsa da tr / en ile sınırlı kalmadan dil kodu temelli çalışmalı.
	•	Session.language source-of-truth: Seans dili bir kere belirlenip DB’de tutulmalı; sonraki akışlar bunu temel almalı.
	•	Voice-first: LLM cevabı “etiketli, JSON’lu, meta’lı” değil; konuşulacak ham metin olmalı.

⸻

Temel Bileşenler

1) Veritabanı (Postgres)

Proje Postgres kullanır (pool ile). Öne çıkan tablolar:
	•	client
	•	id (uuid)
	•	username
	•	gender (int: 0 unknown / 1 male / 2 female)
	•	language (text; örn. tr, en, de, ar…)
	•	created
	•	main_session
	•	id
	•	client_id
	•	created
	•	deleted
	•	Aynı client için seansları gruplayan “ana oturum” kavramı. Trial hesabı burada created üzerinden yapılıyor.
	•	session
	•	id
	•	client_id
	•	therapist_id
	•	main_session_id
	•	number (main_session içinde artan seans numarası)
	•	language (text; seansın dili)
	•	created
	•	ended
	•	summary (seans sonunda üretilen özet)
	•	deleted
	•	message
	•	id
	•	session_id
	•	created
	•	language (mesaj dili; seans diline paralel)
	•	is_client (boolean; user mı assistant mı)
	•	content (text; konuşma metni)
	•	therapist
	•	id
	•	name
	•	description
	•	gender
	•	voice_id (ElevenLabs voice id)
	•	audio_preview_url
	•	client_payment
	•	abonelik / ödeme doğrulama için raw payload veya paid_at gibi alanlar içerir.

Ayrıca DB tarafında yardımcı fonksiyonlar kullanılıyor:
	•	public.get_or_create_main_session(client_id)
	•	public.next_session_number(main_session_id)

⸻

2) Dış Servisler

OpenAI (LLM)
	•	Amaç: Koç/terapist cevaplarını üretmek ve seans sonunda özet üretmek.
	•	Chat completion benzeri JSON payload ile çağrılıyor (model, messages, temperature vs).
	•	“Voice-only” çıktı hedefleniyor: yalnız konuşulacak metin.

ElevenLabs STT
	•	Amaç: Kullanıcı sesini yazıya çevirmek.
	•	language_code ile dil kodu gönderiliyor (örn. tr, en, de…).
	•	STT başarısız/boş dönerse sistem fallback ile devam edebiliyor.

ElevenLabs TTS
	•	Amaç: Asistan metnini ses dosyasına çevirmek.
	•	Terapiste özel voice_id kullanılıyor.
	•	Mobile iki modda dönebiliyor:
	1.	stream=1: direkt audio/mpeg stream
	2.	stream=0: JSON içinde base64 audio

⸻

Dil (Multi-language) Tasarımı

Dilin Kaynağı (Source of Truth)

Dil için temel prensip:
	•	Seans dili session.language alanıdır (DB).
	•	Seans oluştururken dil belirlenir ve kaydedilir.
	•	Sonraki message akışlarında, özellikle STT/TTS/LLM çağrılarında öncelik session.language’dedir.

Fallback Sırası (genel yaklaşım)

Farklı endpoint’lerde küçük farklar olsa da genel niyet:
	1.	session.language (varsa)
	2.	request body’de gelen language (backward compatibility)
	3.	client.language (client create/update’te saklanan)
	4.	default: "tr"

Bu sayede:
	•	Eski mobil sürüm language göndermese bile çalışır,
	•	Yeni sürüm dil gönderirse de seans dili buna göre set edilir,
	•	Daha sonra seans dili sabitlenir.

Dil kodu bağımlılığı

Sistem tr/en gibi iki dillik bir hard-code’a bağlı kalmamalı.
	•	Yeni dil kodları (örn. de, fr, ar) geldiğinde kod “patlamadan” çalışmalı.
	•	İçerik üretimi:
	•	Intro ses dosyaları statik klasörden okunuyor (aşağıda).
	•	Açılış cümlesi/özet/koç yanıtı LLM tarafından hedef dilde üretiliyor (prompt “Output MUST be in ”).
	•	Fallback metinleri varsa bunlar minimal ve güvenli şekilde “bilinmeyen dil → İngilizce” gibi bir default ile dönebilir, ama ideal olan bunların da i18n map’ten gelmesidir.

⸻

Statik Intro Sesleri

İlk seans açılışında sistem “intro mp3” döndürür. Bu mp3 dosyaları static/voices/intro altında tutulur.

Dosya yolu mantığı:
	•	static/voices/intro/{language}/{therapyIntent}/{therapistId}.mp3

Örnek:
	•	static/voices/intro/tr/kaygi/<therapistId>.mp3
	•	static/voices/intro/en/sohbet/<therapistId>.mp3

Bu dosyaların hazırlanması backend’in sorumluluğunda değildir; projede varsayım olarak “orası doğru hazırlanacak” kabul edilir.

Backend yalnızca URL’i üretir:
	•	https://.../static/voices/intro/<lang>/<intent>/<therapistId>.mp3

⸻

Ücret/Deneme Süresi (Paywall + Trial)

Sistem “deneme süresi” kavramı kullanır:
	•	Client’ın bir main_session kaydı yoksa veya main_session.created son 7 gün içindeyse → trial aktif kabul edilir.
	•	Trial değilse, client_payment üzerinden abonelik kontrolü yapılır.
	•	Bazı kullanıcılar için bypass/force:
	•	SKIP_PAYWALL_USER: paywall atlatır
	•	FORCE_PAYWALL_USER: trial’ı kapatır

Bu kontrol /sessions oluşturulurken yapılır; ödeme yoksa 402 payment_required dönebilir.

⸻

Endpointler ve Akışlar

1) POST /clients

Amaç: Client oluşturma veya clientId varsa güncelleme.

Girdi (body):
	•	clientId (opsiyonel) → varsa bunu kullanır; yoksa uuid üretir.
	•	username (opsiyonel) → yoksa otomatik auto-XXXXXXXX
	•	gender (opsiyonel) → 0/1/2 dışındaysa 0’a düşer
	•	language (opsiyonel) → default tr, normalize lower-case

Davranış:
	•	clientId DB’de varsa UPDATE.
	•	Yoksa INSERT.
	•	Username unique çakışma ihtimaline karşı 3 deneme ile auto username retry.

Çıktı:
	•	{ id: <clientId> } (201)

Backwards compatible noktalar:
	•	language/gender eksik gelebilir, default uygulanır.

⸻

2) GET /clients

Tüm client’ları created DESC döner (admin/ops amaçlı).

⸻

3) POST /sessions (Yeni seans)

Amaç: Bir client için yeni bir seans başlatmak.

Girdi (body):
	•	clientId (zorunlu)
	•	therapistId (zorunlu)
	•	therapyIntent (opsiyonel; eski sürümler göndermeyebilir)
	•	language (opsiyonel; eski sürümler göndermeyebilir)

therapyIntent:
	•	izinli değerler: kaygi, zihin, deneme, sohbet
	•	gönderilmiş ama geçersizse 400; gönderilmemişse default sohbet

Dil seçimi:
	•	client’ın DB’deki language’ı alınır; body’deki language varsa override edebilir.
	•	seansın language alanına “effectiveLanguage” yazılır.

Seans numarası:
	•	aynı main_session içinde number artan bir counter gibi işlenir.
	•	race condition ihtimaline karşı insert çakışırsa tekrar number çekip insert retry yapılır.

İlk seans ise:
	•	response’a introUrl eklenir.
	•	openingText ve openingAudioBase64 null döner.

İlk seans değilse:
	•	geçmiş özetleri alır (son 6 seans summary).
	•	OpenAI ile kısa “spoken opening” üretir.
	•	ElevenLabs TTS ile bunun sesini üretir.
	•	response’a openingText ve openingAudioBase64 ekler.

Çıktı:
	•	Seans meta + trial bilgisi + (introUrl veya opening content)

Backwards compatible:
	•	Eski client’lar therapyIntent ve language göndermeden seans açabilir.

⸻

4) POST /sessions/:sessionId/messages/audio

Amaç: Mobile’dan gelen ses → STT → AI → TTS akışı.

Girdi:
	•	multipart form-data:
	•	audio (zorunlu)
	•	language (opsiyonel; backward compat)
	•	query:
	•	stream=1 ise audio stream döner

Akış:
	1.	Session meta baştan çekilir:
	•	session.language ve terapist voiceId
	2.	effectiveLanguage belirlenir:
	•	öncelik: session.language, yoksa body language, yoksa tr
	3.	STT:
	•	Eleven STT çağrılır; language_code = effectiveLanguage
	4.	STT başarısızsa:
	•	fallbackUtterance(effectiveLanguage) ile kullanıcıya kısa bir “yeniden dene” gibi cümle üretilir
	•	DB’ye sadece assistant mesajı yazılır
	•	TTS denenir; başarısızsa yalnız metin döner
	5.	STT başarılıysa:
	•	user mesajı DB’ye yazılır
	•	seans meta + bu seans mesajları çekilir
	•	geçmiş seans özetleri pastSummariesBlock olarak hazırlanır
	•	OpenAI çağrısı:
	•	system prompt + developer message + past summaries + mesaj geçmişi tail
	•	AI cevabı DB’ye yazılır
	•	TTS ile ses üretilir
	•	stream veya JSON(base64) olarak döner

Çıktı (stream=0):
	•	sessionId
	•	userMessageId
	•	aiMessageId
	•	transcript (STT sonucu)
	•	aiText
	•	audioBase64
	•	audioMime

⸻

5) POST /sessions/:sessionId/end

Amaç: Seansı ended yap ve OpenAI ile “extractive” özet üret.

Girdi:
	•	force=1 query ile ended/summary overwrite edilebilir (test/ops)

Akış:
	1.	Seans meta çekilir (session.language dahil)
	2.	Bu seansın tüm mesajları çekilir
	3.	effectiveLanguage:
	•	session.language → last client msg language → default tr
	4.	Transcript hazırlanır (kaba token korumalı)
	5.	Eğer konuşma yoksa:
	•	minimal summary yazılır (TR/EN örneği var)
	6.	Konuşma varsa:
	•	OpenAI “extractive-only” prompt ile summary üretir
	•	summary DB’ye yazılır, ended set edilir

Summary formatı:
	•	İki blok halinde saklanır:
	•	===PUBLIC_BEGIN=== ... ===PUBLIC_END===
	•	===COACH_BEGIN=== ... ===COACH_END===
Bu sayede client’a PUBLIC kısmı gösterilir, opsiyonel coach notu ayrı yönetilir.

⸻

6) GET /sessions/:sessionId/summary

Amaç: summary döndür (PUBLIC, opsiyonel COACH), md veya html.

Parametreler:
	•	format=md|html
	•	coach=1 → coach bloğunu da dahil eder

Davranış:
	•	summary yoksa, backend otomatik olarak /end çağırıp summary üretmeyi dener.
	•	Sonra summary’i parse eder:
	•	PUBLIC / COACH bloklarını ayırır
	•	blok yoksa tüm metni PUBLIC sayar (backward compat)

Çıktı:
	•	JSON içinde summary_markdown (PUBLIC)
	•	coach_markdown opsiyonel
	•	HTML format istenirse basic markdown-to-html dönüşümüyle HTML döner.

⸻

7) GET /clients/:clientId/sessions

Amaç: Bir client’ın seanslarını listeler (paging + status filter).

⸻

8) Terapistler
	•	GET /therapists: liste + arama + paging
	•	GET /therapists/:therapistId/voice-preview: terapistin ses örneği URL’i

⸻

9) Admin/Test Endpointleri
	•	/admin/clients/:clientId/mock-trial-expired
	•	main_session.created’i X gün geriye çeker
	•	client_payment kayıtlarını siler
	•	paywall/trial testini kolaylaştırır
	•	/clients/:clientId/reset
	•	client’ın session kayıtlarını soft-delete eder (main_session kısmı yorum satırında)

⸻

Prompt Yapısı (LLM Davranışı)

LLM’e üç ana “context” gönderilir:
	1.	System Prompt (buildSystemPrompt)
	•	koçluk dili, güvenlik, voice-only, intake zorunluluğu vb.
	2.	Developer Message (buildDeveloperMessage(sessionData))
	•	seans bilgileri, kullanıcı profil alanları, guard’lar
	•	“çıktıda meta etiketleri basma” gibi sert kısıtlar
	3.	Past Summaries Block (main_session’daki önceki seansların summary’leri)
	•	geçmişteki plan/taahhütle tutarlılık için

Bunların üzerine:
	•	Bu seansın son mesajları (tail) eklenir.

Amaç:
	•	LLM çıktısı: yalnız konuşulacak metin (tag yok, JSON yok, meta yok)
	•	“Intake” soruları kontrollü şekilde sorulur (çok soru yok)
	•	Güvenlik: medikal teşhis yok, acil riskte yönlendirme var.

⸻

Backward Compatibility İlkeleri

Bu sistem, eski mobil sürümlerle uyum için şunları garanti eder:
	•	POST /sessions body’de therapyIntent ve language gelmese bile çalışır.
	•	POST /sessions/:id/messages/audio body’de language gelmese bile session.language ile yürür.
	•	Summary blok ayraçları olmayan eski özetler PUBLIC kabul edilerek gösterilebilir.

⸻

Multi-language Genişleme Stratejisi

Bu proje “tr/en” ikilisine sıkı bağlı olmamalı. Genişleme şu şekilde:
	•	STT/TTS: effectiveLanguage doğrudan dış servislere iletilir.
	•	LLM: prompt içinde Output MUST be in <effectiveLanguage> denir.
	•	Statik intro: klasör yapısı dil kodu bazlıdır (/intro/<lang>/...).
	•	Koddaki kalan hard-coded metinler (fallback metinleri gibi) ideal olarak küçük bir i18n map üzerinden yönetilir; bilinmeyen dilde “en” fallback kullanılabilir ama sistem kesinlikle crash etmemelidir.

⸻

Mobil İstemci Beklentileri

Mobil tarafın bekleyebileceği response şekilleri:
	•	Seans oluşturma:
	•	İlk seans → introUrl dolu
	•	Diğer seanslar → openingText + opsiyonel openingAudioBase64
	•	Audio message endpoint:
	•	stream=1 → MP3 bytes
	•	stream=0 → { audioBase64, aiText, transcript, ... }
	•	STT fallback durumunda:
	•	userMessageId null gelebilir
	•	fallback: true gelebilir
	•	yine de aiText döner

⸻

Operasyonel Notlar
	•	Transaction kullanımı önemli:
	•	session insert ve message insert’ler BEGIN/COMMIT ile güvenceye alınmış.
	•	Unique constraint çakışmalarında retry mantığı var.
	•	Token/uzunluk koruması:
	•	mesajların son N adedi ve total char limit ile LLM’e yük bindirmemek hedefleniyor.
	•	Hata durumları:
	•	400 (bad request), 404, 402 (payment required), 500 (internal error)
	•	log’larda ilgili etaplar süre ölçümü ile yazdırılıyor.

⸻
