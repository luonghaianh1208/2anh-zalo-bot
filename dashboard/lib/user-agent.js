// Đọc User-Agent thành nhãn thiết bị dễ hiểu ("Chrome · Windows"). Chỉ để hiển thị — không dùng để xác thực.

const BROWSERS = [
  [/Zalo/i, 'Zalo'],
  [/FBAN|FBAV/i, 'Facebook'],
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/CocCoc/i, 'Cốc Cốc'],
  [/SamsungBrowser/, 'Samsung Internet'],
  [/Firefox\/|FxiOS/, 'Firefox'],
  [/Chrome\/|CriOS/, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS = [
  [/iPhone/, 'iPhone', true],
  [/iPad/, 'iPad', true],
  [/Android/, 'Android', true],
  [/Windows/, 'Windows', false],
  [/Mac OS X|Macintosh/, 'macOS', false],
  [/CrOS/, 'ChromeOS', false],
  [/Linux/, 'Linux', false],
];

export function describeUserAgent(ua) {
  const s = String(ua || '');
  if (!s) return { label: 'Thiết bị không rõ', mobile: false };
  const browser = BROWSERS.find(([re]) => re.test(s))?.[1] || '';
  const sys = SYSTEMS.find(([re]) => re.test(s));
  const label = [browser, sys?.[1]].filter(Boolean).join(' · ') || 'Thiết bị không rõ';
  return { label, mobile: Boolean(sys?.[2]) || /Mobile/i.test(s) };
}
