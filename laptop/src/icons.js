// Symbole für die Specs (passend zur Bezeichnung) – genutzt von Präsentation und Spec-Lasche.
(function () {
  const svg = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const ICONS = [
    [/prozessor|cpu|chip/i, svg('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>')],
    [/arbeitsspeicher|ram|memory/i, svg('<rect x="2" y="7" width="20" height="10" rx="1.5"/><path d="M6 10v4M10 10v4M14 10v4M18 10v4M5 17v2M19 17v2"/>')],
    [/speicher|ssd|festplatte|storage/i, svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".8"/><path d="M6.5 7h.01M17.5 17h.01"/>')],
    [/grafik|gpu|graphics/i, svg('<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="9" cy="12" r="3"/><circle cx="16.5" cy="12" r="1.5"/><path d="M5 18v2M10 18v2"/>')],
    [/display|bildschirm|screen|panel/i, svg('<rect x="3" y="4" width="18" height="12" rx="1.8"/><path d="M2 19h20M9 16l-.5 3M15 16l.5 3"/>')],
    [/akku|batter/i, svg('<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 10.5v3M11 9l-2.5 3.5h4L10 16"/>')],
    [/betriebssystem|windows|macos|os\b|system/i, svg('<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>')],
    [/gewicht|weight/i, svg('<path d="M6.5 8h11l2.5 12H4z"/><circle cx="12" cy="5.5" r="2.5"/>')],
    [/kamera|webcam|camera/i, svg('<path d="M3 8h3.5L8.5 5h7l2 3H21v11H3z"/><circle cx="12" cy="13" r="3.5"/>')],
    [/wlan|wifi|wi-fi|funk|bluetooth/i, svg('<path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0"/><circle cx="12" cy="19.2" r="1"/>')],
    [/anschl|port|usb|thunderbolt/i, svg('<path d="M12 2v15M8 6l4-4 4 4M7 11v3l5 3M17 9v3l-5 3"/><circle cx="12" cy="19.5" r="2"/>')],
    [/tastatur|keyboard/i, svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>')],
    [/preis|price|€|angebot/i, svg('<path d="M20.5 13.5l-7 7a2 2 0 0 1-2.8 0L3 12.8V3h9.8l7.7 7.7a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>')],
    [/garantie|warranty/i, svg('<path d="M12 2l8 3.5v6c0 5-3.5 8.5-8 10.5-4.5-2-8-5.5-8-10.5v-6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>')],
  ];
  const DEFAULT = svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/>');
  window.specIcon = label => (ICONS.find(([re]) => re.test(label || "")) || [0, DEFAULT])[1];
  window.isPrice = label => /preis|price/i.test(label || "");
  window.escapeHtml = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
})();
