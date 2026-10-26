-- AI Sales module — starter content (editable in /sales/ → Templates & objections, Follow-up automation).
-- No customer data, prices or promotions are seeded. Follow-up sequences are seeded INACTIVE as examples.

insert into public.ai_objections (key, examples, guidance_en, guidance_ms, clarifying_question_en, clarifying_question_ms, escalate) values
('price_too_high', array['Harga mahal','Mahal sangat','Too expensive'],
 'Acknowledge the concern. Ask which budget range is comfortable. Compare using verified prices only (price per sqft, layout, tenure, facilities, location). Offer smaller layouts or other projects within budget if they exist. Never invent discounts.',
 'Akui kebimbangan. Tanya julat bajet yang selesa. Bandingkan dengan harga yang disahkan sahaja (harga sekaki persegi, pelan, pegangan, kemudahan, lokasi). Cadangkan pelan lebih kecil atau projek lain dalam bajet jika ada. Jangan reka diskaun.',
 'May I know the budget range you are comfortable with?', 'Boleh saya tahu julat bajet yang tuan/puan selesa?', false),
('installment_too_high', array['Monthly installment terlalu tinggi','Bulanan tinggi sangat'],
 'Explain that the instalment depends on loan amount, rate, tenure and financing type. Offer an estimate with stated assumptions; never present it as a loan offer. Suggest LPPSA vs bank comparison if relevant, or a lower-priced layout.',
 'Terangkan ansuran bergantung pada jumlah pinjaman, kadar, tempoh dan jenis pembiayaan. Beri anggaran dengan andaian yang jelas; jangan nyatakan sebagai tawaran pinjaman. Cadangkan perbandingan LPPSA dan bank jika sesuai, atau pelan lebih rendah harga.',
 'What monthly amount would feel comfortable for you?', 'Berapa anggaran bulanan yang tuan/puan rasa selesa?', false),
('need_to_think', array['Saya nak fikir dulu','Let me think first'],
 'Respect the decision. Offer to send a short summary (layouts, verified price, location) and ask if a specific point is still unclear. Ask permission before any follow-up.',
 'Hormati keputusan. Tawarkan ringkasan pendek (pelan, harga disahkan, lokasi) dan tanya jika ada perkara yang masih kurang jelas. Minta izin sebelum membuat susulan.',
 'Is there anything specific you would like me to clarify?', 'Ada perkara tertentu yang tuan/puan nak saya jelaskan?', false),
('discuss_with_spouse', array['Saya nak bincang dengan isteri','Saya nak bincang dengan suami','Need to ask my wife/husband'],
 'Support it. Offer materials they can share (brochure, floor plan, website link) and offer a joint showroom visit or video call at a time that suits both.',
 'Sokong keputusan itu. Tawarkan bahan untuk dikongsi (brosur, pelan lantai, pautan laman web) dan tawarkan lawatan showroom atau panggilan video bersama pada masa yang sesuai untuk kedua-duanya.',
 'Would a joint showroom visit or video call be helpful?', 'Adakah lawatan showroom atau panggilan video bersama akan membantu?', false),
('loan_worry', array['Takut susah nak dapat loan','Takut loan tak lulus'],
 'Acknowledge. Explain approval depends on income, commitments, credit record and the financier. Offer a preliminary check based on information they choose to share, or a session with a qualified person. Never guarantee approval.',
 'Akui kebimbangan. Terangkan kelulusan bergantung pada pendapatan, komitmen, rekod kredit dan pihak pembiaya. Tawarkan semakan awal berdasarkan maklumat yang mereka pilih untuk kongsi, atau sesi dengan pihak yang layak. Jangan jamin kelulusan.',
 'Would you like a preliminary eligibility check?', 'Tuan/puan nak buat semakan kelayakan awal?', true),
('cashback_doubt', array['Saya tak percaya cashback','Cashback betul ke?'],
 'State that any cashback or rebate is subject to the official written promotion terms. Share only approved, currently valid promotion details with their conditions and source. If none is on record, say confirmation is required.',
 'Nyatakan sebarang cashback atau rebat tertakluk pada syarat promosi rasmi secara bertulis. Kongsi hanya butiran promosi yang diluluskan dan masih sah bersama syarat dan sumbernya. Jika tiada rekod, nyatakan perlu pengesahan.',
 null, null, false),
('location_far', array['Lokasi jauh','Too far'],
 'Ask where they work or commute to. Share verified connectivity (transit, highways, travel considerations) honestly, including trade-offs. Suggest closer projects if available.',
 'Tanya lokasi tempat kerja atau perjalanan harian. Kongsi maklumat ketersambungan yang disahkan (pengangkutan awam, lebuh raya) secara jujur termasuk kekurangannya. Cadangkan projek lebih dekat jika ada.',
 'Where do you usually commute to?', 'Tuan/puan biasanya berulang-alik ke kawasan mana?', false),
('too_many_projects', array['Banyak projek baru dekat kawasan ini'],
 'Agree it is worth comparing. Offer an objective comparison on verified facts (price psf, tenure, maintenance fee, completion, facilities). Do not disparage competitors.',
 'Setuju perbandingan itu wajar. Tawarkan perbandingan objektif berdasarkan fakta disahkan (harga sekaki persegi, pegangan, yuran penyelenggaraan, tarikh siap, kemudahan). Jangan memburukkan pesaing.',
 'Which other projects are you considering?', 'Projek lain mana yang tuan/puan sedang pertimbangkan?', false),
('price_drop_fear', array['Saya takut harga property jatuh','Saya nak tunggu harga turun'],
 'Acknowledge the uncertainty. Explain no one can predict prices and the AI cannot guarantee appreciation. Focus on fit for own-stay needs, affordability and verified facts. Offer to keep them informed only with consent.',
 'Akui ketidakpastian. Terangkan tiada siapa boleh meramal harga dan tiada jaminan kenaikan nilai. Fokus pada kesesuaian untuk didiami, kemampuan dan fakta disahkan. Tawarkan untuk memaklumkan perkembangan dengan izin sahaja.',
 'Are you buying mainly for own stay or investment?', 'Tuan/puan beli untuk didiami atau pelaburan?', false),
('already_own_home', array['Saya dah ada rumah'],
 'Respect it. Ask whether they are considering an upgrade, a home for family, or investment. Mention that financing terms and eligibility may differ for an additional property and confirmation is needed.',
 'Hormati. Tanya sama ada mereka mempertimbangkan naik taraf, rumah untuk keluarga atau pelaburan. Maklumkan syarat pembiayaan dan kelayakan mungkin berbeza untuk hartanah tambahan dan perlu disahkan.',
 'Is this for an upgrade, family, or investment?', 'Ini untuk naik taraf, keluarga atau pelaburan?', false),
('more_discount', array['Boleh bagi discount lagi?','Can discount more?'],
 'Do not negotiate or promise. Share only approved current promotions. Hand over to a human advisor for any special pricing request.',
 'Jangan berunding atau berjanji. Kongsi hanya promosi semasa yang diluluskan. Serahkan kepada penasihat manusia untuk sebarang permintaan harga istimewa.',
 null, null, true),
('rental_demand', array['Saya nak tahu rental demand','Boleh sewa berapa?'],
 'Share only verified, sourced rental information if present in the knowledge base, clearly labelled as indicative. Otherwise say verified data is not available and offer an advisor follow-up. Never state a yield as fact.',
 'Kongsi hanya maklumat sewaan yang disahkan dan bersumber jika ada dalam pangkalan pengetahuan, dilabel sebagai anggaran. Jika tiada, nyatakan data disahkan tidak tersedia dan tawarkan susulan penasihat. Jangan nyatakan pulangan sebagai fakta.',
 null, null, false),
('guaranteed_return', array['Boleh guarantee investment return?'],
 'Say clearly that returns and capital appreciation cannot be guaranteed. Offer verified facts and a conversation with a human advisor.',
 'Nyatakan dengan jelas pulangan dan kenaikan nilai tidak boleh dijamin. Tawarkan fakta disahkan dan perbincangan dengan penasihat manusia.',
 null, null, true),
('late_completion', array['Saya risau projek lambat siap'],
 'Acknowledge. Share the verified expected completion date and developer information on record. Explain buyer protections are in the SPA and legal questions go to a human advisor or lawyer.',
 'Akui kebimbangan. Kongsi jangkaan tarikh siap yang disahkan dan maklumat pemaju yang ada dalam rekod. Terangkan perlindungan pembeli ada dalam SPA dan soalan undang-undang dirujuk kepada penasihat manusia atau peguam.',
 null, null, true)
on conflict (key) do nothing;

insert into public.ai_follow_up_sequences (name, lead_type, steps, active) values
('New enquiry (example)', 'new_enquiry', '[
  {"delay_hours": 24,  "purpose": "service",   "instruction": "If no reply, check in once about their original question."},
  {"delay_hours": 72,  "purpose": "service",   "instruction": "Share one useful verified fact or answer a likely concern."},
  {"delay_hours": 168, "purpose": "service",   "instruction": "Ask whether they would like a consultation or showroom visit."},
  {"delay_hours": 336, "purpose": "marketing", "instruction": "Final relevant follow-up, then pause or move to nurture."}
]'::jsonb, false),
('Appointment pending (example)', 'appointment_pending', '[
  {"delay_hours": 4,  "purpose": "service", "instruction": "Remind them a preferred slot is still pending confirmation and ask for an alternative if needed."},
  {"delay_hours": 24, "purpose": "service", "instruction": "Ask once more, then hand over to an advisor."}
]'::jsonb, false),
('Missed appointment (example)', 'missed_appointment', '[
  {"delay_hours": 2,  "purpose": "service", "instruction": "Politely ask if they would like to reschedule."},
  {"delay_hours": 72, "purpose": "service", "instruction": "Offer a video call alternative."}
]'::jsonb, false),
('Post-viewing (example)', 'post_viewing', '[
  {"delay_hours": 24, "purpose": "service", "instruction": "Thank them and ask if any questions remain after the visit."},
  {"delay_hours": 96, "purpose": "service", "instruction": "Share any requested documents and offer an advisor call."}
]'::jsonb, false)
on conflict (name) do nothing;
