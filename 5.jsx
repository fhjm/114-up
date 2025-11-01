import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, onSnapshot, collection, query, where, addDoc, setDoc, updateDoc, deleteDoc, getDocs } from 'firebase/firestore';
import { BarChart, Bar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts';
import { Lightbulb, Lock, User, CheckCircle, AlertTriangle, Loader, BarChart2, TrendingUp, Users, Clipboard } from 'lucide-react';

// --- 全域變數和設定 (由 Canvas 環境提供) ---
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? initialAuthToken : undefined;
const API_KEY = ""; // 預留給 Gemini API
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=" + API_KEY;

// 科目與權重設定
const SUBJECT_WEIGHTS = {
    chinese: 5,
    math: 4,
    english: 3,
    science: 3,
    social: 3,
};
const SUBJECT_NAMES_CH = {
    chinese: '國文',
    math: '數學',
    english: '英文',
    science: '自然',
    social: '社會',
    essay: '作文', // 作文不計入加權
};
const EXAM_OPTIONS = ['第一次段考', '第二次段考', '第三次段考'];
const TEACHER_PIN = '999999'; // 導師固定管理 PIN 碼

// --- 輔助函式 ---

/**
 * 實現指數退避的 API 呼叫函式
 */
const fetchWithExponentialBackoff = async (payload, maxRetries = 5) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const response = await fetch(GEMINI_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                if (response.status === 429 || response.status >= 500) {
                    throw new Error(`Server error: ${response.status}`);
                }
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) return text;

            throw new Error("Gemini response is empty or invalid.");
        } catch (error) {
            if (i === maxRetries - 1) {
                console.error("Gemini API call failed after multiple retries:", error);
                throw new Error("無法生成成績評語，請稍後再試。");
            }
            const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
            console.warn(`Gemini API call failed, retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
};

/**
 * 呼叫 Gemini API 產生個人化成績總結和評語
 */
const generateGeminiSummary = async (studentName, grades, weightedAverage) => {
    const systemPrompt = "你是一位經驗豐富、富有同理心的學術導師。根據提供的學生姓名和各科成績（包括加權平均），生成一份簡潔、鼓舞人心的成績總結和評語。評語應使用繁體中文，長度不超過三句話，重點指出學生的優勢和一個潛在的進步領域，並鼓勵學生。";

    const subjectGrades = Object.entries(grades)
        .map(([key, value]) => `${SUBJECT_NAMES_CH[key]}: ${value}`)
        .join(', ');

    const userQuery = `請為學生 ${studentName} 撰寫成績評語。成績如下：${subjectGrades}，加權平均: ${weightedAverage.toFixed(2)}。`;

    const payload = {
        contents: [{ parts: [{ text: userQuery }] }],
        systemInstruction: { parts: [{ text: systemPrompt }] },
    };

    return fetchWithExponentialBackoff(payload);
};

/**
 * 計算加權平均
 */
const calculateWeightedAverage = (grades) => {
    let totalScore = 0;
    let totalWeight = 0;
    for (const subject in SUBJECT_WEIGHTS) {
        if (grades[subject] !== undefined) {
            totalScore += grades[subject] * SUBJECT_WEIGHTS[subject];
            totalWeight += SUBJECT_WEIGHTS[subject];
        }
    }
    return totalWeight > 0 ? totalScore / totalWeight : 0;
};

/**
 * 生成獨一無二的 6 位數 PIN 碼
 */
const generateUniquePin = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * 將文本複製到剪貼簿 (不使用 alert)
 */
const copyToClipboard = (text) => {
    if (document.execCommand) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = 0; // 隱藏
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            return true;
        } catch (err) {
            console.error('Fallback: Failed to copy text: ', err);
            return false;
        } finally {
            document.body.removeChild(textarea);
        }
    } else {
        console.error('Browser does not support document.execCommand for copy.');
        return false;
    }
};

// --- 子組件 (保持不變或微調以符合新邏輯) ---

// 通用卡片
const Card = ({ title, children, className = '' }) => (
    <div className={`bg-white p-6 rounded-xl shadow-lg border border-sky-100 ${className}`}>
        <h2 className="text-xl font-bold text-sky-700 mb-4 border-b pb-2">{title}</h2>
        {children}
    </div>
);

// 數據卡片
const StatCard = ({ title, value, icon }) => (
    <div className="bg-white p-5 rounded-xl shadow-md border border-sky-200 flex items-center justify-between transition duration-300 hover:shadow-lg hover:border-sky-400">
        <div>
            <p className="text-sm font-medium text-gray-500">{title}</p>
            <p className="text-3xl font-extrabold text-sky-800 mt-1">{value}</p>
        </div>
        <div className="p-3 bg-sky-100 rounded-full">{icon}</div>
    </div>
);

// Tab 按鈕
const TabButton = ({ active, onClick, children }) => (
    <button
        onClick={onClick}
        className={`px-4 py-2 rounded-lg font-medium transition duration-200 ${active ? 'bg-sky-600 text-white shadow-md' : 'text-gray-700 hover:bg-sky-100'}`}
    >
        {children}
    </button>
);

// 段考選擇器
const ExamSelector = ({ selectedExam, setSelectedExam }) => (
    <div className="flex items-center space-x-3 mb-4">
        <label className="font-medium text-gray-700">選擇段考別:</label>
        <select
            className="p-2 border border-sky-300 rounded-lg text-sm bg-white focus:ring-sky-500 focus:border-sky-500"
            value={selectedExam}
            onChange={(e) => setSelectedExam(e.target.value)}
        >
            {EXAM_OPTIONS.map(exam => (
                <option key={exam} value={exam}>{exam}</option>
            ))}
        </select>
    </div>
);

// 學生端：單科成績表格
const SubjectGradeTable = ({ grades, classAvgData }) => {
    const data = Object.keys(SUBJECT_NAMES_CH).map(key => ({
        subject: SUBJECT_NAMES_CH[key],
        score: grades[key] || 0,
        average: classAvgData?.[key]?.toFixed(1) || 'N/A',
        key: key
    }));

    return (
        <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-sky-50">
                    <tr>
                        <th className="px-6 py-3 text-left font-medium text-sky-700 uppercase tracking-wider">科目名稱</th>
                        <th className="px-6 py-3 text-left font-medium text-sky-700 uppercase tracking-wider">分數 ({grades.examName})</th>
                        <th className="px-6 py-3 text-left font-medium text-sky-700 uppercase tracking-wider">權重</th>
                        <th className="px-6 py-3 text-left font-medium text-sky-700 uppercase tracking-wider">班級平均</th>
                        <th className="px-6 py-3 text-left font-medium text-sky-700 uppercase tracking-wider">表現比較</th>
                    </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                    {data.map(({ subject, score, average, key }) => {
                        const weight = SUBJECT_WEIGHTS[key] || 0;
                        const comparison = average !== 'N/A' ? (score >= parseFloat(average) ? '優於平均' : '低於平均') : 'N/A';
                        const comparisonColor = comparison === '優於平均' ? 'text-green-600 font-semibold' : comparison === '低於平均' ? 'text-red-500' : 'text-gray-500';

                        return (
                            <tr key={subject} className="hover:bg-sky-50 transition">
                                <td className="px-6 py-4 whitespace-nowrap font-medium text-gray-900">{subject} ({weight > 0 ? `*${weight}` : '不計入'})</td>
                                <td className="px-6 py-4 whitespace-nowrap text-gray-700">{score}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-gray-700">{weight}</td>
                                <td className="px-6 py-4 whitespace-nowrap text-gray-700">{average}</td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <span className={`text-xs px-2 inline-flex leading-5 font-semibold rounded-full ${comparisonColor}`}>
                                        {comparison}
                                    </span>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
};

// 加權平均分數散佈圖
const ClassAverageScatterPlot = ({ scatterData, classAverage, studentName, isTeacherView = false }) => {
    // 區分學生和班級
    const studentData = scatterData.filter(d => d.name === studentName);
    const classData = scatterData.filter(d => d.name !== studentName);

    // 確定 x 軸的範圍
    const allAverages = scatterData.map(d => d.avg);
    const minAvg = Math.floor(Math.min(...allAverages, 60) / 10) * 10;
    const maxAvg = Math.ceil(Math.max(...allAverages, 100) / 10) * 10;

    // 給散佈圖數據加上一個 Y 軸值，讓點位不重疊 (教師視圖) 或區分學生 (學生視圖)
    const processedData = scatterData.map((d, index) => ({
        ...d,
        yAxisValue: isTeacherView ? 0.5 + (Math.random() - 0.5) * 0.4 : (d.name === studentName ? 1 : 0.5) // 教師視圖給隨機微小偏移
    }));

    return (
        <ResponsiveContainer width="100%" height={isTeacherView ? 300 : 350}>
            <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e0f2f1" />
                <XAxis
                    type="number"
                    dataKey="avg"
                    name="加權平均分數"
                    unit="分"
                    domain={[minAvg, maxAvg]}
                    tickCount={Math.ceil((maxAvg - minAvg) / 10) + 1}
                />
                <YAxis
                    type="number"
                    dataKey="yAxisValue" // 使用新的 Y 軸值
                    name={isTeacherView ? "班級分佈" : "您"}
                    domain={isTeacherView ? [0, 1] : [0, 1]}
                    tick={false}
                    axisLine={false}
                />
                <Tooltip cursor={{ strokeDasharray: '3 3' }} content={({ payload }) => {
                    if (payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                            <div className="bg-white p-2 border rounded shadow-md text-sm">
                                <p className="font-semibold">{data.name}</p>
                                <p>平均: {data.avg.toFixed(2)} 分</p>
                            </div>
                        );
                    }
                    return null;
                }} />

                <Legend />
                <Scatter name="所有學生" data={processedData} fill="#0ea5e9" shape={({ cx, cy, payload }) => {
                    // 使用星形來突出顯示當前學生
                    return payload.name === studentName ? (
                        <svg x={cx - 10} y={cy - 10} width="20" height="20" viewBox="0 0 24 24" fill="#ef4444" stroke="#c0392b" strokeWidth="1.5">
                            <polygon points="12,2 15,9 22,9 17,14 19,21 12,17 5,21 7,14 2,9 9,9" />
                        </svg>
                    ) : (
                        <circle cx={cx} cy={cy} r={6} fill={isTeacherView ? '#a8a29e' : '#0ea5e9'} />
                    );
                }} />

                {/* 班級平均線 */}
                {classAverage > 0 && (
                    <ReferenceLine x={classAverage} stroke="#0d9488" strokeDasharray="3 3" label={{ value: `班級平均: ${classAverage.toFixed(2)}`, position: 'top', fill: '#0d9488' }} />
                )}
            </ScatterChart>
        </ResponsiveContainer>
    );
};

// 教師端：成績總覽表格
const TeacherGradeTable = ({ grades, calculateRank, openEditModal, handleDeleteGrade }) => {
    return (
        <div className="overflow-x-auto shadow-md rounded-xl">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-sky-100">
                    <tr>
                        <th className="px-4 py-3 text-center font-medium text-sky-800">班排</th>
                        <th className="px-4 py-3 text-left font-medium text-sky-800">學生姓名</th>
                        <th className="px-4 py-3 text-center font-medium text-sky-800">段考別</th>
                        <th className="px-4 py-3 text-center font-medium text-sky-800">國文(*5)</th>
                        <th className="px-4 py-3 text-center font-medium text-sky-800">數學(*4)</th>
                        <th className="px-4 py-3 text-center font-medium text-sky-800">英文(*3)</th>
                        <th className="px-4 py-3 text-center font-medium text-sky-800">自然(*3)</th>
                        <th className="px-4 py-3 text-center font-medium text-sky-800">社會(*3)</th>
                        <th className="px-4 py-3 text-center font-medium text-sky-800">作文</th>
                        <th className="px-4 py-3 text-center font-medium text-sky-800">加權平均</th>
                        <th className="px-4 py-3 text-center font-medium text-sky-800">操作</th>
                    </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                    {grades.map(grade => (
                        <tr key={grade.id} className="hover:bg-sky-50 transition">
                            <td className="px-4 py-3 whitespace-nowrap text-center font-bold text-sky-700">{calculateRank(grade.studentName, grade.examName)}</td>
                            <td className="px-4 py-3 whitespace-nowrap font-medium text-gray-900">{grade.studentName}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-center text-gray-600">{grade.examName}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-center text-gray-700">{grade.chinese}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-center text-gray-700">{grade.math}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-center text-gray-700">{grade.english}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-center text-gray-700">{grade.science}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-center text-gray-700">{grade.social}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-center text-gray-700">{grade.essay}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-center font-semibold text-sky-600">{grade.weightedAverage.toFixed(2)}</td>
                            <td className="px-4 py-3 whitespace-nowrap text-center space-x-2">
                                <button
                                    onClick={() => openEditModal(grade)}
                                    className="text-sky-600 hover:text-sky-900 font-medium"
                                >
                                    編輯
                                </button>
                                <button
                                    onClick={() => handleDeleteGrade(grade.id)}
                                    className="text-red-600 hover:text-red-900 font-medium"
                                >
                                    刪除
                                </button>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

// 教師端：PIN 碼總覽表格
const PinOverviewTable = ({ studentPins, setMessage }) => {
    const handleExport = () => {
        if (studentPins.length === 0) {
            setMessage('無學生 PIN 碼資料可供導出。');
            return;
        }

        const header = "姓名,查詢PIN碼\n";
        const csv = studentPins.map(p => `${p.name},${p.pin}`).join('\n');
        const fullCsv = header + csv;

        if (copyToClipboard(fullCsv)) {
            setMessage('已將 PIN 碼列表複製到剪貼簿 (CSV 格式)。');
        } else {
            setMessage('複製到剪貼簿失敗，請手動複製。');
        }
    };

    return (
        <div className="overflow-x-auto shadow-md rounded-xl">
            <div className="flex justify-between items-center p-4 bg-white rounded-t-xl border-b">
                <p className="text-gray-600">總共有 {studentPins.length} 筆學生 PIN 碼紀錄。</p>
                <div className="space-x-3">
                    <button
                        onClick={handleExport}
                        className="flex items-center px-3 py-1.5 bg-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-300 transition"
                    >
                        <Clipboard size={16} className="mr-1.5" /> 複製列表 (CSV)
                    </button>
                </div>
            </div>
            <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-sky-100">
                    <tr>
                        <th className="px-6 py-3 text-left font-medium text-sky-800">學生姓名</th>
                        <th className="px-6 py-3 text-left font-medium text-sky-800">查詢 PIN 碼 (6位數，固定)</th>
                    </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                    {studentPins.map(pin => (
                        <tr key={pin.id} className="hover:bg-sky-50 transition">
                            <td className="px-6 py-4 whitespace-nowrap font-medium text-gray-900">{pin.name}</td>
                            <td className="px-6 py-4 whitespace-nowrap font-mono text-lg text-sky-600 font-semibold">{pin.pin}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
};

// 成績編輯模態框
const GradeEditModal = ({ editForm, setEditForm, handleSaveGrade, onClose, isNew }) => {
    const title = isNew ? '新增學生成績' : `編輯 ${editForm.studentName} 的成績`;

    const handleChange = (e) => {
        const { name, value } = e.target;
        // 確保分數輸入為數字且在 0-100 範圍內
        const isGradeField = name.match(/(chinese|math|english|science|social|essay)/);
        let newValue = value;

        if (isGradeField) {
            // 使用 Number(value) 確保即使是空字串也轉為 0，避免 NaN
            const numValue = Number(value);
            newValue = Math.max(0, Math.min(100, isNaN(numValue) ? 0 : numValue));
        }

        setEditForm(prev => ({ ...prev, [name]: isGradeField ? newValue : value }));
    };

    return (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75 flex items-center justify-center p-4 z-50">
            <Card title={title} className="max-w-xl w-full">
                <form onSubmit={(e) => { e.preventDefault(); handleSaveGrade(); }} className="space-y-4">
                    <div>
                        <label htmlFor="studentName" className="block text-sm font-medium text-gray-700">學生姓名</label>
                        <input
                            type="text"
                            name="studentName"
                            id="studentName"
                            value={editForm.studentName || ''}
                            onChange={handleChange}
                            required
                            // 僅在新增時可修改姓名，確保 PIN 碼綁定不變
                            disabled={!isNew}
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-sky-500 focus:ring-sky-500 p-2 border disabled:bg-gray-50"
                        />
                    </div>
                    <div>
                        <label htmlFor="examName" className="block text-sm font-medium text-gray-700">段考別</label>
                        <select
                            name="examName"
                            id="examName"
                            value={editForm.examName || EXAM_OPTIONS[0]}
                            onChange={handleChange}
                            required
                            className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-sky-500 focus:ring-sky-500 p-2 border bg-white"
                        >
                            {EXAM_OPTIONS.map(exam => <option key={exam} value={exam}>{exam}</option>)}
                        </select>
                    </div>

                    <div className="grid grid-cols-2 gap-4">
                        {Object.keys(SUBJECT_NAMES_CH).map(key => (
                            <div key={key}>
                                <label htmlFor={key} className="block text-sm font-medium text-gray-700">
                                    {SUBJECT_NAMES_CH[key]} {SUBJECT_WEIGHTS[key] ? `(*${SUBJECT_WEIGHTS[key]})` : ''}
                                </label>
                                <input
                                    type="number"
                                    name={key}
                                    id={key}
                                    value={editForm[key] || 0}
                                    onChange={handleChange}
                                    required
                                    min="0"
                                    max="100"
                                    className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-sky-500 focus:ring-sky-500 p-2 border"
                                />
                            </div>
                        ))}
                    </div>

                    <div className="flex justify-end space-x-3 pt-4 border-t">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-200 rounded-lg hover:bg-gray-300 transition"
                        >
                            取消
                        </button>
                        <button
                            type="submit"
                            className="px-4 py-2 text-sm font-medium text-white bg-sky-600 rounded-lg hover:bg-sky-700 transition"
                        >
                            {isNew ? '新增' : '儲存變更'}
                        </button>
                    </div>
                </form>
            </Card>
        </div>
    );
};

// 登入介面組件 (已從 App 內部移出，解決重渲染和焦點問題)
const LoginScreen = ({ 
    loginName, 
    setLoginName, 
    loginPin, 
    setLoginPin, 
    handleStudentLogin, 
    handleTeacherLogin, 
    message, 
    loading, 
    setMessage 
}) => {
    // 身份切換狀態現在是 LoginScreen 的本地狀態，並會在 App 重渲染時保持住
    const [selectedIdentity, setSelectedIdentity] = useState('student');
    const isStudent = selectedIdentity === 'student';
    const isTeacher = selectedIdentity === 'teacher';

    return (
        <div className="min-h-screen flex items-center justify-center bg-sky-50 p-4">
            <div className="max-w-md w-full space-y-8 bg-white p-10 rounded-2xl shadow-2xl">
                <div className="text-center">
                    <h2 className="mt-6 text-4xl font-extrabold text-sky-700">
                        線上成績查詢系統
                    </h2>
                    <p className="mt-2 text-sm text-gray-500">
                        請選擇您的身份並登入
                    </p>
                    {message && (
                        <p className="mt-4 text-sm text-red-500 bg-red-100 p-2 rounded-md border border-red-300">
                            <AlertTriangle size={16} className="inline-block mr-1" />{message}
                        </p>
                    )}
                </div>

                <div className="space-y-6">
                    {/* 身份切換 */}
                    <div className="flex justify-center space-x-4">
                        <button
                            onClick={() => {setSelectedIdentity('teacher'); setMessage(''); setLoginName('');}}
                            className={`flex-1 p-3 rounded-xl font-semibold transition ${isTeacher ? 'bg-sky-500 text-white shadow-lg' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                        >
                            <User className="inline mr-2" size={18} /> 導師登入
                        </button>
                        <button
                            onClick={() => {setSelectedIdentity('student'); setMessage('');}}
                            className={`flex-1 p-3 rounded-xl font-semibold transition ${isStudent ? 'bg-sky-500 text-white shadow-lg' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
                        >
                            <User className="inline mr-2" size={18} /> 學生查詢
                        </button>
                    </div>

                    <form className="mt-8 space-y-6" onSubmit={(e) => {
                        e.preventDefault();
                        // 提交表單時，才觸發實際登入邏輯
                        if (isStudent) handleStudentLogin();
                        if (isTeacher) handleTeacherLogin();
                    }}>
                        <div className="rounded-lg shadow-sm -space-y-px">
                            {isStudent && (
                                <div>
                                    <label htmlFor="name" className="sr-only">姓名</label>
                                    <input
                                        id="name"
                                        name="name"
                                        type="text"
                                        required
                                        className="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-lg focus:outline-none focus:ring-sky-500 focus:border-sky-500 focus:z-10 sm:text-sm"
                                        placeholder="姓名 (學生查詢用)"
                                        value={loginName}
                                        onChange={(e) => setLoginName(e.target.value)}
                                    />
                                </div>
                            )}
                            <div>
                                <label htmlFor="pin" className="sr-only">PIN 碼</label>
                                <input
                                    id="pin"
                                    name="pin"
                                    type="password"
                                    inputMode="numeric" // 確保在移動端喚起數字鍵盤
                                    pattern="[0-9]*"    // 確保輸入是數字
                                    required
                                    maxLength={6}
                                    className={`appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-sky-500 focus:border-sky-500 focus:z-10 sm:text-sm ${isStudent ? 'rounded-b-lg' : 'rounded-lg'}`}
                                    placeholder={isStudent ? "6 位數查詢 PIN 碼" : `導師管理 PIN 碼 (${TEACHER_PIN})`}
                                    value={loginPin}
                                    onChange={(e) => {
                                        const value = e.target.value;
                                        // 限制輸入只能是數字
                                        if (/^\d*$/.test(value)) {
                                            setLoginPin(value);
                                        }
                                    }}
                                />
                            </div>
                        </div>

                        <button
                            type="submit"
                            // 修正禁用邏輯：必須輸入 6 位 PIN 碼，且如果是學生身份，姓名不能為空
                            disabled={loading || loginPin.length !== 6 || (isStudent && loginName.length === 0)}
                            className={`group relative w-full flex justify-center py-3 px-4 border border-transparent text-sm font-medium rounded-lg text-white bg-sky-600 hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-sky-500 transition duration-150 ease-in-out shadow-lg disabled:opacity-50`}
                        >
                            {loading ? <Loader size={20} className="animate-spin" /> : (isStudent ? '學生查詢' : '導師登錄')}
                        </button>
                    </form>
                </div>
            </div>
        </div>
    );
};


// --- 主要應用程式元件 ---

const App = () => {
    // Firebase 狀態
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null); // 當前用戶的 UID
    const [authReady, setAuthReady] = useState(false); // 認證流程是否完成

    // 應用程式數據狀態
    const [classGrades, setClassGrades] = useState([]);
    const [studentPins, setStudentPins] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [message, setMessage] = useState('');

    // UI/使用者狀態
    const [userRole, setUserRole] = useState('guest'); // 'guest', 'student', 'teacher'
    const [studentInfo, setStudentInfo] = useState(null); // 當前登入的學生數據

    // 登入表單狀態
    const [loginName, setLoginName] = useState('');
    const [loginPin, setLoginPin] = useState('');

    // 1. Firebase 初始化和認證
    useEffect(() => {
        if (Object.keys(firebaseConfig).length === 0) {
            setError('Firebase 配置遺失。');
            setLoading(false);
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const firebaseAuth = getAuth(app);

            setDb(firestore);
            setAuth(firebaseAuth);

            const authenticate = async (auth) => {
                try {
                    if (initialAuthToken) {
                        await signInWithCustomToken(auth, initialAuthToken);
                    } else {
                        await signInAnonymously(auth);
                    }
                } catch (e) {
                    console.error("Authentication failed:", e);
                    setError('Firebase 認證失敗。');
                }
            };

            onAuthStateChanged(firebaseAuth, (user) => {
                if (user) {
                    // 認證成功，設置 UID
                    setUserId(user.uid); 
                } else {
                    // 認證失敗或登出，將 userId 設為 null
                    setUserId(null); 
                }
                // 認證流程完成
                setAuthReady(true);
                setLoading(false);
            });

            authenticate(firebaseAuth);

        } catch (e) {
            console.error("Firebase Initialization Error:", e);
            setError('Firebase 初始化失敗。');
            setLoading(false);
        }
    }, []);

    // 2. Firestore 數據訂閱 (只有在 authReady 且 auth.currentUser 存在時才執行)
    useEffect(() => {
        if (!db || !authReady) return; // Wait for Firebase instance and auth process to finish

        // 關鍵檢查: 確保一個用戶物件存在，才能進行依賴 request.auth 的 Firestore 操作
        const currentUser = auth.currentUser;
        if (!currentUser) {
            console.warn("Skipping Firestore subscriptions: User is not authenticated.");
            // 清空數據以反映未認證狀態
            setClassGrades([]);
            setStudentPins([]);
            return;
        }
        
        // 使用已認證用戶的 UID 構建私有資料路徑
        const authenticatedUid = currentUser.uid;

        // --- 1. 公開資料: 學生 PINs ---
        // 路徑不包含 UID，但需要認證通過 (request.auth != null)
        const pinsRef = collection(db, `/artifacts/${appId}/public/data/student_pins`);
        const unsubscribePins = onSnapshot(pinsRef, (snapshot) => {
            const pinsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setStudentPins(pinsData);
        }, (err) => {
            console.error("Error fetching student pins:", err);
            // 即使是公開資料，若權限不足，可能表示身份未被認可
            if (err.message.includes('permission')) {
                setMessage('錯誤：無法獲取 PIN 碼資料，請重新登入。');
            }
        });

        // --- 2. 私人資料: 班級成績 ---
        // 路徑必須使用已認證用戶的 UID
        const gradesRef = collection(db, `/artifacts/${appId}/users/${authenticatedUid}/class_grades`);
        const unsubscribeGrades = onSnapshot(gradesRef, (snapshot) => {
            const gradesData = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                weightedAverage: calculateWeightedAverage(doc.data()),
            }));
            setClassGrades(gradesData);
        }, (err) => {
            console.error("Error fetching class grades:", err);
            if (err.message.includes('permission')) {
                setMessage('錯誤：無法獲取您的班級成績資料，請聯繫管理員。');
            }
        });

        return () => {
            unsubscribePins();
            unsubscribeGrades();
        };

    }, [db, authReady, auth]); // 依賴於 db, authReady 和 auth 實例

    // 3. 處理應用程式邏輯

    /**
     * 處理學生登入
     */
    const handleStudentLogin = () => {
        const student = studentPins.find(p => p.name === loginName && p.pin === loginPin);

        if (student) {
            const studentGrades = classGrades.filter(g => g.studentName === loginName);
            if (studentGrades.length > 0) {
                setStudentInfo({
                    name: loginName,
                    pin: loginPin,
                    grades: studentGrades
                });
                setUserRole('student');
                setMessage(`學生 ${loginName} 登入成功！`);
            } else {
                setMessage('查無該學生的成績資料，請聯繫導師確認。');
            }
        } else {
            setMessage('姓名或 PIN 碼錯誤，請檢查後重試。');
        }
    };

    /**
     * 處理教師登入 (簡化邏輯：僅依賴 PIN 碼)
     */
    const handleTeacherLogin = () => {
        if (loginPin === TEACHER_PIN) {
            setUserRole('teacher');
            setMessage('導師身份驗證成功！');
        } else {
            setMessage('導師 PIN 碼錯誤。');
        }
    };

    /**
     * 新增學生 PIN 碼 (僅在該學生首次新增成績時使用)
     * @param {string} studentName - 學生姓名
     */
    const addStudentPin = async (studentName) => {
        if (!db) return;
        // 公開資料不需要 userId，因此路徑正確
        const pinsRef = collection(db, `/artifacts/${appId}/public/data/student_pins`);
        const newPin = generateUniquePin();

        try {
            await addDoc(pinsRef, { name: studentName, pin: newPin });
            setMessage(`已為 ${studentName} 生成新 PIN: ${newPin}。`);
            return newPin;
        } catch (e) {
            console.error("Error adding student pin:", e);
            setMessage(`生成 PIN 碼失敗：${e.message}`);
        }
    };

    // 導師功能：數據管理狀態
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [currentEditGrade, setCurrentEditGrade] = useState(null);
    const [editForm, setEditForm] = useState({});

    /**
     * 打開成績編輯/新增模態框
     */
    const openEditModal = (gradeData = null) => {
        if (gradeData) {
            setCurrentEditGrade(gradeData);
            setEditForm(gradeData);
        } else {
            setCurrentEditGrade(null);
            setEditForm({
                studentName: '',
                examName: EXAM_OPTIONS[0],
                chinese: 0,
                math: 0,
                english: 0,
                science: 0,
                social: 0,
                essay: 0,
            });
        }
        setIsModalOpen(true);
    };

    /**
     * 儲存或更新成績 - 包含建立學生 PIN 的流程
     */
    const handleSaveGrade = async () => {
        // 使用 auth.currentUser.uid 確保路徑的正確性
        if (!db || !auth.currentUser) {
            setMessage('錯誤：身份驗證信息丟失，請嘗試重新整理。');
            return;
        }

        const authenticatedUid = auth.currentUser.uid;
        const gradesRef = collection(db, `/artifacts/${appId}/users/${authenticatedUid}/class_grades`);

        try {
            // 確保所有分數都是數字
            const gradesToSave = {
                ...editForm,
                chinese: Number(editForm.chinese),
                math: Number(editForm.math),
                english: Number(editForm.english),
                science: Number(editForm.science),
                social: Number(editForm.social),
                essay: Number(editForm.essay),
            };

            if (currentEditGrade) {
                // 流程 1: 更新現有成績
                const gradeDocRef = doc(gradesRef, currentEditGrade.id);
                await updateDoc(gradeDocRef, gradesToSave);
                setMessage('成績更新成功！');
            } else {
                // 流程 2: 新增成績
                await addDoc(gradesRef, gradesToSave);

                // **學生帳號建立流程**：檢查是否已存在 PIN，若無則生成並新增 (固定密碼)
                const existingPin = studentPins.find(p => p.name === gradesToSave.studentName);
                if (!existingPin) {
                    await addStudentPin(gradesToSave.studentName);
                } else {
                    setMessage(`成績新增成功！學生 ${gradesToSave.studentName} 已有 PIN 碼: ${existingPin.pin}`);
                }
            }
            setIsModalOpen(false);
        } catch (e) {
            console.error("Error saving grade:", e);
            setMessage('儲存成績失敗：' + e.message);
        }
    };

    /**
     * 刪除成績
     */
    const handleDeleteGrade = async (id) => {
        if (!db || !auth.currentUser || !window.confirm('確定要刪除這筆成績資料嗎？')) return;
        try {
            const authenticatedUid = auth.currentUser.uid;
            const gradeDocRef = doc(db, `/artifacts/${appId}/users/${authenticatedUid}/class_grades`, id);
            await deleteDoc(gradeDocRef);
            setMessage('成績刪除成功！');
        } catch (e) {
            console.error("Error deleting grade:", e);
            setMessage('刪除成績失敗：' + e.message);
        }
    };

    /**
     * 計算班級排名
     */
    const calculateRank = useCallback((studentName, examName) => {
        const examGrades = classGrades
            .filter(g => g.examName === examName)
            .map(g => ({
                ...g,
                weightedAverage: calculateWeightedAverage(g)
            }))
            .sort((a, b) => b.weightedAverage - a.weightedAverage); // 降序

        const studentIndex = examGrades.findIndex(g => g.studentName === studentName);
        return studentIndex !== -1 ? studentIndex + 1 : 'N/A';
    }, [classGrades]);

    // 輔助儀表板數據處理 (使用 useMemo 保持性能)
    const calculateClassAverages = useMemo(() => {
        const results = {};
        EXAM_OPTIONS.forEach(exam => {
            const examGrades = classGrades.filter(g => g.examName === exam);
            if (examGrades.length === 0) return;

            const subjectAverages = {};
            let totalWeightedSum = 0;
            let totalWeightedCount = 0;

            Object.keys(SUBJECT_NAMES_CH).forEach(subject => {
                const total = examGrades.reduce((sum, g) => sum + (g[subject] || 0), 0);
                subjectAverages[subject] = examGrades.length > 0 ? (total / examGrades.length) : 0;

                if (SUBJECT_WEIGHTS[subject]) {
                    totalWeightedSum += subjectAverages[subject] * SUBJECT_WEIGHTS[subject];
                    totalWeightedCount += SUBJECT_WEIGHTS[subject];
                }
            });

            results[exam] = {
                ...subjectAverages,
                classAverage: totalWeightedCount > 0 ? totalWeightedSum / totalWeightedCount : 0,
                totalStudents: examGrades.length
            };
        });
        return results;
    }, [classGrades]);


    // 4. UI/組件

    // 學生端儀表板組件
    const StudentDashboard = ({ studentInfo, classGrades, calculateRank, classAverages }) => {
        const [selectedExam, setSelectedExam] = useState(EXAM_OPTIONS[0]);
        const [geminiSummary, setGeminiSummary] = useState(null);
        const [isGeminiLoading, setIsGeminiLoading] = useState(false);

        const currentGrades = studentInfo.grades.find(g => g.examName === selectedExam);

        const currentRank = currentGrades ? calculateRank(studentInfo.name, selectedExam) : 'N/A';
        const weightedAvg = currentGrades ? currentGrades.weightedAverage : 0;
        const classAvgData = classAverages[selectedExam];
        const studentOverallAvg = currentGrades ? Object.values(currentGrades).filter(v => typeof v === 'number' && v <= 100).reduce((a, b) => a + b, 0) / Object.keys(SUBJECT_NAMES_CH).length : 0;

        // 雷達圖數據準備
        const radarData = useMemo(() => {
            if (!currentGrades || !classAvgData) return [];

            return Object.keys(SUBJECT_WEIGHTS).map(subject => ({
                subject: SUBJECT_NAMES_CH[subject],
                A: currentGrades[subject] || 0, // 學生分數
                B: classAvgData[subject] || 0,  // 班級平均
                fullMark: 100,
            }));
        }, [currentGrades, classAvgData]);

        // 散佈圖數據準備 (所有段考的加權平均)
        const scatterData = useMemo(() => {
            const examGrades = classGrades.filter(g => g.examName === selectedExam);
            
            return examGrades.map(g => ({
                name: g.studentName,
                avg: g.weightedAverage,
                isStudent: g.studentName === studentInfo.name
            }));
        }, [classGrades, selectedExam, studentInfo.name]);

        // 呼叫 Gemini
        const handleGenerateSummary = useCallback(async () => {
            if (!currentGrades) return;

            setIsGeminiLoading(true);
            setGeminiSummary(null);
            try {
                const gradesForGemini = {
                    chinese: currentGrades.chinese,
                    math: currentGrades.math,
                    english: currentGrades.english,
                    science: currentGrades.science,
                    social: currentGrades.social,
                    essay: currentGrades.essay,
                };
                const summary = await generateGeminiSummary(studentInfo.name, gradesForGemini, weightedAvg);
                setGeminiSummary(summary);
            } catch (e) {
                setGeminiSummary(`生成評語失敗: ${e.message}`);
            } finally {
                setIsGeminiLoading(false);
            }
        }, [currentGrades, studentInfo.name, weightedAvg]);


        return (
            <div className="p-6 bg-white rounded-xl shadow-2xl space-y-6 max-w-7xl mx-auto">
                <h1 className="text-3xl font-extrabold text-sky-700 border-b pb-2">
                    👋 歡迎，{studentInfo.name} 同學！
                </h1>
                <div className="flex justify-between items-center text-sm font-mono text-sky-600 bg-sky-50 p-3 rounded-lg">
                    <span>您的專屬查詢 PIN 碼 (請妥善保管): <Lock size={16} className="inline-block mr-1" />{studentInfo.pin}</span>
                    <select
                        className="p-2 border border-sky-300 rounded-lg text-sm bg-white focus:ring-sky-500 focus:border-sky-500"
                        value={selectedExam}
                        onChange={(e) => {
                            setSelectedExam(e.target.value);
                            setGeminiSummary(null); // 切換段考時清除評語
                        }}
                    >
                        {EXAM_OPTIONS.map(exam => (
                            <option key={exam} value={exam}>{exam}</option>
                        ))}
                    </select>
                </div>

                {!currentGrades ? (
                    <div className="text-center py-10 text-gray-500">
                        目前查無 {selectedExam} 的成績數據。
                    </div>
                ) : (
                    <>
                        {/* 儀表板總覽 */}
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
                            <StatCard title="整體平均分數" value={studentOverallAvg.toFixed(1)} icon={<BarChart2 className="text-sky-600" />} />
                            <StatCard title="加權平均分數" value={weightedAvg.toFixed(1)} icon={<TrendingUp className="text-sky-600" />} />
                            <StatCard title={`${selectedExam} 班級排名`} value={`${currentRank} / ${classAvgData?.totalStudents || '?'}`} icon={<Users className="text-sky-600" />} />
                            <StatCard title="班級加權平均" value={classAvgData?.classAverage.toFixed(1) || 'N/A'} icon={<BarChart2 className="text-sky-600" />} />
                        </div>

                        {/* 雷達圖 與 成績評語 */}
                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                            <Card title="科目表現雷達圖 (對比班級平均)">
                                <ResponsiveContainer width="100%" height={350}>
                                    <RadarChart data={radarData} outerRadius={110}>
                                        <PolarGrid stroke="#e0f2f1" />
                                        <PolarAngleAxis dataKey="subject" />
                                        <PolarRadiusAxis angle={90} domain={[0, 100]} />
                                        <Radar name={studentInfo.name} dataKey="A" stroke="#0369a1" fill="#0ea5e9" fillOpacity={0.6} />
                                        <Radar name="班級平均" dataKey="B" stroke="#f97316" fill="#f97316" fillOpacity={0.1} />
                                        <Legend wrapperStyle={{ paddingTop: '20px' }} />
                                    </RadarChart>
                                </ResponsiveContainer>
                                <p className="text-xs text-gray-500 mt-2 text-center">
                                    註：雷達圖比較您在五大主科與班級平均的表現。
                                </p>
                            </Card>
                            <Card title="個人成績總結與評語">
                                {geminiSummary ? (
                                    <div className="p-4 bg-sky-50 border-l-4 border-sky-500 text-sky-800 rounded-lg shadow-inner">
                                        <h3 className="font-semibold flex items-center mb-2"><Lightbulb size={20} className="mr-2" />導師評語 (Gemini AI 生成)</h3>
                                        <p className="text-sm leading-relaxed whitespace-pre-line">{geminiSummary}</p>
                                        <button
                                            onClick={() => setGeminiSummary(null)}
                                            className="mt-3 text-xs text-sky-600 hover:text-sky-800 font-medium"
                                        >
                                            [清除評語]
                                        </button>
                                    </div>
                                ) : (
                                    <div className="flex flex-col items-center justify-center h-full min-h-[200px] p-4 bg-gray-50 rounded-lg">
                                        <p className="text-gray-500 mb-4">點擊下方按鈕，由 Gemini AI 為您分析成績並提供評語。</p>
                                        <button
                                            onClick={handleGenerateSummary}
                                            disabled={isGeminiLoading}
                                            className="flex items-center px-4 py-2 bg-sky-500 text-white font-medium rounded-full shadow-lg hover:bg-sky-600 transition disabled:opacity-50"
                                        >
                                            {isGeminiLoading ? (
                                                <Loader size={20} className="animate-spin mr-2" />
                                            ) : (
                                                <Lightbulb size={20} className="mr-2" />
                                            )}
                                            {isGeminiLoading ? '生成中...' : '生成 Gemini 評語'}
                                        </button>
                                    </div>
                                )}
                            </Card>
                        </div>

                        {/* 單科成績及班級分佈 */}
                        <Card title={`${selectedExam} 單科成績詳情與加權平均分佈`} className="mt-6">
                            <SubjectGradeTable grades={currentGrades} classAvgData={classAvgData} />
                            <div className='pt-6'>
                                <h3 className='text-lg font-semibold text-gray-700 mb-2'>加權平均分數散佈圖</h3>
                                <ClassAverageScatterPlot scatterData={scatterData} classAverage={classAvgData?.classAverage} studentName={studentInfo.name} />
                            </div>
                        </Card>
                    </>
                )}
            </div>
        );
    };

    // 教師端儀表板組件
    const TeacherDashboard = ({ classGrades, studentPins, classAverages, calculateRank, setMessage }) => {
        const [viewMode, setViewMode] = useState('summary'); // 'summary', 'grades', 'pins'
        const [selectedExam, setSelectedExam] = useState(EXAM_OPTIONS[0]);

        const filteredGrades = useMemo(() => {
            return classGrades
                .filter(g => g.examName === selectedExam)
                .sort((a, b) => calculateRank(a.studentName, selectedExam) - calculateRank(b.studentName, selectedExam));
        }, [classGrades, selectedExam, calculateRank]);

        // 班級總覽數據
        const classSummaryData = useMemo(() => {
            if (!classAverages[selectedExam]) return [];
            const avg = classAverages[selectedExam];
            return Object.keys(SUBJECT_WEIGHTS).map(subject => ({
                subject: SUBJECT_NAMES_CH[subject],
                average: avg[subject].toFixed(1)
            }));
        }, [classAverages, selectedExam]);

        return (
            <div className="p-6 bg-white rounded-xl shadow-2xl space-y-6 max-w-7xl mx-auto">
                <h1 className="text-3xl font-extrabold text-sky-700 border-b pb-2">
                    👨‍🏫 導師成績管理中心
                </h1>
                <div className="flex space-x-4 border-b pb-4">
                    <TabButton active={viewMode === 'summary'} onClick={() => setViewMode('summary')}>
                        📊 班級段考總覽
                    </TabButton>
                    <TabButton active={viewMode === 'grades'} onClick={() => setViewMode('grades')}>
                        📝 成績登錄與管理
                    </TabButton>
                    <TabButton active={viewMode === 'pins'} onClick={() => setViewMode('pins')}>
                        🔐 學生密碼總覽
                    </TabButton>
                </div>

                {/* 內容區域 */}
                {viewMode === 'summary' && (
                    <div className="space-y-6">
                        <ExamSelector selectedExam={selectedExam} setSelectedExam={setSelectedExam} />

                        {classAverages[selectedExam] && (
                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                <Card title={`${selectedExam} 科目平均總覽`}>
                                    <ResponsiveContainer width="100%" height={300}>
                                        <BarChart data={classSummaryData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
                                            <CartesianGrid strokeDasharray="3 3" stroke="#e0f2f1" />
                                            <XAxis dataKey="subject" />
                                            <YAxis domain={[0, 100]} />
                                            <Tooltip />
                                            <Bar dataKey="average" name="平均分數" fill="#0ea5e9" radius={[10, 10, 0, 0]} />
                                        </BarChart>
                                    </ResponsiveContainer>
                                </Card>

                                <Card title={`${selectedExam} 班級加權平均分數散佈圖`}>
                                    <ClassAverageScatterPlot
                                        scatterData={filteredGrades.map(g => ({ name: g.studentName, avg: g.weightedAverage }))}
                                        classAverage={classAverages[selectedExam].classAverage}
                                        isTeacherView={true}
                                    />
                                </Card>
                            </div>
                        )}

                        <Card title={`${selectedExam} 學生每次段考個別成績總攬 (可排序)`}>
                            <TeacherGradeTable
                                grades={filteredGrades}
                                calculateRank={calculateRank}
                                openEditModal={openEditModal}
                                handleDeleteGrade={handleDeleteGrade}
                            />
                        </Card>
                    </div>
                )}

                {viewMode === 'grades' && (
                    <div className="space-y-6">
                        <div className="flex justify-between items-center">
                            <h2 className="text-2xl font-semibold text-gray-700">成績登錄與修改</h2>
                            <button
                                onClick={() => openEditModal(null)}
                                className="flex items-center px-4 py-2 bg-sky-600 text-white font-medium rounded-lg shadow-md hover:bg-sky-700 transition"
                            >
                                + 新增學生/成績
                            </button>
                        </div>
                        <ExamSelector selectedExam={selectedExam} setSelectedExam={setSelectedExam} />
                        <TeacherGradeTable
                            grades={filteredGrades}
                            calculateRank={calculateRank}
                            openEditModal={openEditModal}
                            handleDeleteGrade={handleDeleteGrade}
                        />
                    </div>
                )}

                {viewMode === 'pins' && (
                    <div className="space-y-6">
                        <h2 className="text-2xl font-semibold text-gray-700">學生密碼總覽 (不變更，固定)</h2>
                        <PinOverviewTable studentPins={studentPins} setMessage={setMessage} />
                    </div>
                )}
            </div>
        );
    };

    // 渲染主體
    if (loading || !authReady) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-sky-50">
                <div className="flex items-center text-xl font-medium text-sky-700 p-6 bg-white rounded-xl shadow-lg">
                    <Loader size={24} className="animate-spin mr-3" />
                    系統載入中...
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="min-h-screen flex items-center justify-center bg-red-50 p-4">
                <div className="text-center p-6 bg-white rounded-xl shadow-lg">
                    <AlertTriangle size={32} className="text-red-500 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-red-700">錯誤</h2>
                    <p className="text-gray-600">{error}</p>
                </div>
            </div>
        );
    }

    if (userRole === 'guest') {
        // 將所有需要的 props 傳給 LoginScreen
        return (
            <LoginScreen
                loginName={loginName}
                setLoginName={setLoginName}
                loginPin={loginPin}
                setLoginPin={setLoginPin}
                handleStudentLogin={handleStudentLogin}
                handleTeacherLogin={handleTeacherLogin}
                message={message}
                loading={loading}
                setMessage={setMessage}
            />
        );
    }

    return (
        <div className="min-h-screen bg-sky-50 py-10">
            <div className="max-w-7xl mx-auto px-4">
                {/* 中央訊息提示 */}
                {message && (
                    <div className="bg-green-100 border-l-4 border-green-500 text-green-700 p-4 mb-4 rounded-lg flex justify-between items-center" role="alert">
                        <p className="font-bold flex items-center"><CheckCircle size={20} className="mr-2" /> {message}</p>
                        <button onClick={() => setMessage('')} className="text-green-700 hover:text-green-900 font-bold ml-4">×</button>
                    </div>
                )}
                {userRole === 'student' && studentInfo && (
                    <StudentDashboard
                        studentInfo={studentInfo}
                        classGrades={classGrades}
                        calculateRank={calculateRank}
                        classAverages={calculateClassAverages}
                    />
                )}
                {userRole === 'teacher' && (
                    <TeacherDashboard
                        classGrades={classGrades}
                        studentPins={studentPins}
                        classAverages={calculateClassAverages}
                        calculateRank={calculateRank}
                        setMessage={setMessage}
                    />
                )}
            </div>

            {/* 編輯/新增模態框 (Modal) */}
            {isModalOpen && (
                <GradeEditModal
                    editForm={editForm}
                    setEditForm={setEditForm}
                    handleSaveGrade={handleSaveGrade}
                    onClose={() => setIsModalOpen(false)}
                    isNew={!currentEditGrade}
                />
            )}

            {/* 登出按鈕 (修復登出 bug，確保狀態完全重置) */}
            {(userRole === 'student' || userRole === 'teacher') && (
                <button
                    onClick={() => {
                        setUserRole('guest');
                        setStudentInfo(null);
                        setLoginName('');
                        setLoginPin('');
                        setMessage('已成功登出系統。'); // 登出成功訊息將顯示在登入畫面
                    }}
                    className="fixed top-4 right-4 px-4 py-2 bg-red-500 text-white font-medium rounded-full shadow-lg hover:bg-red-600 transition z-50"
                >
                    登出
                </button>
            )}
        </div>
    );
};

export default App;
