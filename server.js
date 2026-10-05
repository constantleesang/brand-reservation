const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 설정
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Supabase 설정
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://gpplcfeeuxsanujakgdd.supabase.co'; 
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_Gmk6NGhdwPqD8slu9Z6WDw_nwaNF2aH'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 1. 전체 예약 목록 조회
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
    const { date } = req.query;
    try {
        let query = supabase.from('time_slots').select('*');
        if (date) {
            query = query.eq('date', date);
        }
        const { data, error } = await query;
        if (error) throw error;
        res.json(data);
    } catch (err) {
        res.status(500).json({ success: false, message: '시간표 조회 실패' });
    }
});

// 3. 관리자: 시간대 아이디 기반 활성/비활성화 토글
app.patch('/api/time-slots/:id', async (req, res) => {
    const id = req.params.id;
    const { isActive } = req.body;
    try {
        const { error } = await supabase.from('time_slots').update({ is_active: isActive }).eq('id', id);
        if (error) throw error;
        res.json({ success: true, message: '시간 상태가 변경되었습니다.' });
    } catch (err) {
        res.status(500).json({ success: false, message: '시간 상태 변경 실패' });
    }
});

// 3-1. 관리자: 시간대별 최대 제한 인원 변경 API
app.patch('/api/time-slots/:id/capacity', async (req, res) => {
    const id = req.params.id;
    const { maxCapacity } = req.body;
    try {
        const { error } = await supabase.from('time_slots').update({ max_capacity: Number(maxCapacity) }).eq('id', id);
        if (error) throw error;
        res.json({ success: true, message: '시간대별 최대 인원이 변경되었습니다.' });
    } catch (err) {
        res.status(500).json({ success: false, message: '인원 변경 실패' });
    }
});

// 4. 브랜드/사이즈별 현재 신청 인원 카운트 조회
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

// 6. 예약 신청 (설정 인원 초과 시 자동 마감 및 예외 처리)
app.post('/api/reservations', async (req, res) => {
    const { name, phone, department, studentId, brand, shoeSize, date, time, privacyAgreed } = req.body;

    if (!name || !phone || !department || !studentId || !brand || !shoeSize || !date || !time || !privacyAgreed) {
        return res.status(400).json({ success: false, message: '모든 항목을 입력하고 개인정보에 동의해주세요.' });
    }

    try {
        // 전체 예약 데이터 조회
        const { data: allData, error: fetchErr } = await supabase.from('brand_reservations').select('*').neq('status', 'cancelled');
        if (fetchErr) throw fetchErr;

        // 학번 또는 연락처 중복 체크
        const isDuplicate = allData.some(item => item.phone === phone || item.student_id === studentId);
        if (isDuplicate) {
            return res.status(400).json({ success: false, message: '이미 해당 학번이나 연락처로 신청된 내역이 존재합니다. (1인 1회)' });
        }

        // 1) 브랜드 및 사이즈별 정원 체크 (최대 3명)
        const sizeCount = allData.filter(item => item.brand === brand && item.shoe_size === String(shoeSize)).length;
        if (sizeCount >= 3) {
            return res.status(400).json({ success: false, message: `선택하신 [${brand} - ${shoeSize}mm]는 이미 정원 3명이 마감되었습니다.` });
        }

        // 2) 날짜 및 시간대 슬롯 정보 조회
        const { data: slotData, error: slotErr } = await supabase.from('time_slots').select('*').eq('date', date).eq('time', time).single();
        if (slotErr || !slotData) {
            return res.status(400).json({ success: false, message: '유효하지 않은 예약 시간대입니다.' });
        }

        if (!slotData.is_active) {
            return res.status(400).json({ success: false, message: `선택하신 [${date} ${time}] 시간대는 이미 마감되었습니다.` });
        }

        // 3) 시간대별 실제 예약자 수 및 최대 제한 인원(max_capacity) 비교
        const timeCount = allData.filter(item => item.date === date && item.time === time).length;
        const maxLimit = slotData.max_capacity; 

        if (timeCount >= maxLimit) {
            // 정원 초과 시 자동으로 시간대 상태를 비활성화(마감) 처리
            await supabase.from('time_slots').update({ is_active: false }).eq('id', slotData.id);
            return res.status(400).json({ success: false, message: `선택하신 [${date} ${time}] 시간대는 정원 ${maxLimit}명이 마감되었습니다. (자동 마감 처리됨)` });
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

        // 만약 이번 예약으로 인해 정원이 꽉 차게 되었다면 해당 슬롯을 자동으로 비활성화(마감) 처리
        if (timeCount + 1 >= maxLimit) {
            await supabase.from('time_slots').update({ is_active: false }).eq('id', slotData.id);
        }

        res.json({ success: true, message: '신발 데이터 베이스 구축 참여 예약이 완료되었습니다!' });
    } catch (err) {
        console.error('예약 처리 중 에러 발생:', err);
        res.status(500).json({ success: false, message: '서버 오류로 예약을 완료하지 못했습니다.' });
    }
});

// 7. 예약 취소 (취소 시 자리가 생기므로 시간대 활성화 상태 자동 복구 기능 추가 가능)
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
