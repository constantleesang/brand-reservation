const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER, // 본인의 지메일 주소
        pass: process.env.GMAIL_PASS
  // 아까 발급받은 16자리 앱 비밀번호
    }
});
const mailOptions = {
    from: process.env.GMAIL_USER,
    to: process.env.legendoa9@gmail.com, // 관리자 알림을 받을 본인 지메일 주소
    subject: '[CBNU 신발 예약] 새로운 예약이 접수되었습니다!',
    text: `[신규 예약 정보]\n\n- 브랜드: ${brand}\n- 예약 시간: ${time_slot}\n- 학번: ${student_id}\n- 이름: ${name}`
};

await transporter.sendMail(mailOptions);
console.log('관리자 알림 이메일 전송 성공!');

const app = express();
const PORT = process.env.PORT || 3000; // Render 배포를 위해 환경 변수 포트 설정

// 👇 이 코드가 반드시 있어야 public 폴더 안의 파일들을 읽을 수 있습니다!
app.use(express.static('public'));
app.use(express.json()); // JSON 데이터 처리를 위해 함께 추가해 주세요

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gpplcfeeuxsanujakgdd.supabase.co'; 
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Gmk6NGhdwPqD8slu9Z6WDw_nwaNF2aH'; 

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. 전체 예약 목록 조회 (관리자용 - 신청시간 포함, 카멜케이스 매핑)
app.get('/api/reservations', async (req, res) => {
    try {
        const { data, error } = await supabase.from('brand_reservations').select('*').order('created_at', { ascending: false });
        if (error) throw error;
        
        const formatted = data.map(item => ({
            ...item,
            studentId: item.student_id,
            shoeSize: item.shoe_size,
            createdAt: item.created_at
        }));
        res.json(formatted);
    } catch (err) {
        res.status(500).json({ success: false, message: '목록 조회 실패' });
    }
});

// 2. 시간대별 활성화 상태 조회
app.get('/api/time-slots', async (req, res) => {
    try {
        const { data, error } = await supabase.from('time_slots').select('*');
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ success: false, message: '시간표 조회 실패' });
    }
});

// 3. 관리자: 시간대 활성/비활성화 토글
app.patch('/api/time-slots/:time', async (req, res) => {
    const time = req.params.time;
    const { isActive } = req.body;
    try {
        const { error } = await supabase.from('time_slots').update({ is_active: isActive }).eq('time', time);
        if (error) throw error;
        res.json({ success: true, message: '시간 상태가 변경되었습니다.' });
    } catch (err) {
        res.status(500).json({ success: false, message: '시간 상태 변경 실패' });
    }
});

// 4. 브랜드/사이즈별 현재 신청 인원 카운트 조회 (실시간 마감용)
app.get('/api/shoe-counts', async (req, res) => {
    try {
        const { data, error } = await supabase.from('brand_reservations').select('brand, shoe_size, status').neq('status', 'cancelled');
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ success: false, message: '인원 조회 실패' });
    }
});

// 5. 내 예약 조회 (전화번호 기준)
app.get('/api/reservations/search', async (req, res) => {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ success: false, message: '연락처를 입력해주세요.' });
    try {
        const { data, error } = await supabase.from('brand_reservations').select('*').eq('phone', phone).neq('status', 'cancelled');
        if (error) throw error;
        const formatted = data.map(item => ({
            ...item,
            studentId: item.student_id,
            shoeSize: item.shoe_size,
            createdAt: item.created_at
        }));
        res.json(formatted);
    } catch (err) {
        res.status(500).json({ success: false, message: '검색 실패' });
    }
});

// 6. 예약 신청 (중복 체크 및 사이즈별 3명 제한 검증)
app.post('/api/reservations', async (req, res) => {
    const { name, phone, department, studentId, brand, shoeSize, date, time, privacyAgreed } = req.body;

    if (!name || !phone || !department || !studentId || !brand || !shoeSize || !date || !time || !privacyAgreed) {
        return res.status(400).json({ success: false, message: '모든 항목을 입력하고 개인정보에 동의해주세요.' });
    }

    try {
        // 전체 예약 데이터 조회 (중복 및 사이즈 정원 체크용)
        const { data: allData, error: fetchErr } = await supabase.from('brand_reservations').select('*').neq('status', 'cancelled');
        if (fetchErr) throw fetchErr;

        // 학번 또는 연락처 중복 체크
        const isDuplicate = allData.some(item => item.phone === phone || item.student_id === studentId);
        if (isDuplicate) {
            return res.status(400).json({ success: false, message: '이미 해당 학번이나 연락처로 신청된 내역이 존재합니다. (1인 1회)' });
        }

        // 해당 브랜드의 해당 사이즈 신청자 수 카운트 (최대 3명 제한)
        const sizeCount = allData.filter(item => item.brand === brand && item.shoe_size === String(shoeSize)).length;
        if (sizeCount >= 3) {
            return res.status(400).json({ success: false, message: `선택하신 [${brand} - ${shoeSize}mm]는 이미 정원 3명이 마감되었습니다.` });
        }

        const newReservation = {
            id: Date.now(),
            name,
            phone,
            department,
            student_id: studentId,
            brand,
            shoe_size: String(shoeSize),
            date,
            time,
            status: 'confirmed'
        };

        const { error: insertErr } = await supabase.from('brand_reservations').insert([newReservation]);
        if (insertErr) throw insertErr;

        res.json({ success: true, message: '신발 데이터 베이스 구축 참여 예약이 완료되었습니다!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: '서버 오류로 예약을 완료하지 못했습니다.' });
    }
});

// 7. 예약 취소
app.delete('/api/reservations/:id', async (req, res) => {
    const id = Number(req.params.id);
    try {
        const { error } = await supabase.from('brand_reservations').update({ status: 'cancelled' }).eq('id', id);
        if (error) throw error;
        res.json({ success: true, message: '예약이 취소되었습니다.' });
    } catch (err) {
        res.status(500).json({ success: false, message: '취소 중 오류 발생' });
    }
});

app.listen(PORT, () => {
    console.log(`서버 실행 중: http://localhost:${PORT}`);
});
