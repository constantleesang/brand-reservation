const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 설정
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase 설정
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gpplcfeeuxsanujakgdd.supabase.co'; 
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Gmk6NGhdwPqD8slu9Z6WDw_nwaNF2aH'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Nodemailer 지메일 설정
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.GMAIL_USER, // Render 환경 변수 연동
        pass: process.env.GMAIL_PASS  // Render 환경 변수 연동 (16자리 앱 비밀번호)
    }
});

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

// 6. 예약 신청 (중복 체크, 사이즈별 3명 제한 검증 및 메일 타임아웃 방지 비동기 처리)
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

        // 💡 프론트엔드로 성공 응답을 즉시 반환하여 "서버 오류" 메시지 원천 차단
        res.json({ success: true, message: '신발 데이터 베이스 구축 참여 예약이 완료되었습니다!' });

        // 메일 발송은 백그라운드에서 처리 (네트워크 타임아웃이 발생해도 예약 성공에는 영향 없음)
        const mailOptions = {
            from: process.env.GMAIL_USER,
            to: process.env.GMAIL_USER,
            subject: '[CBNU 신발 예약] 새로운 예약이 접수되었습니다!',
            text: `[신규 예약 정보]\n\n- 이름: ${name}\n- 학번: ${studentId}\n- 학과: ${department}\n- 연락처: ${phone}\n- 브랜드: ${brand}\n- 사이즈: ${shoeSize}mm\n- 예약일시: ${date} ${time}`
        };

        transporter.sendMail(mailOptions).then(() => {
            console.log('관리자 알림 이메일 전송 성공!');
        }).catch(mailErr => {
            console.log('메일 전송 실패 (네트워크 타임아웃 등):', mailErr.message);
        });

    } catch (err) {
        console.error('예약 처리 중 에러 발생:', err);
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

// 서버 실행
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
