const PALETTE = [
  { bg: "rgba(99,102,241,0.12)",  color: "#4338ca", border: "rgba(99,102,241,0.25)"  }, // indigo
  { bg: "rgba(6,182,212,0.12)",   color: "#0e7490", border: "rgba(6,182,212,0.25)"   }, // cyan
  { bg: "rgba(5,150,105,0.12)",   color: "#065f46", border: "rgba(5,150,105,0.25)"   }, // emerald
  { bg: "rgba(217,119,6,0.12)",   color: "#92400e", border: "rgba(217,119,6,0.25)"   }, // amber
  { bg: "rgba(225,29,72,0.12)",   color: "#9f1239", border: "rgba(225,29,72,0.25)"   }, // rose
  { bg: "rgba(124,58,237,0.12)",  color: "#5b21b6", border: "rgba(124,58,237,0.25)"  }, // violet
  { bg: "rgba(2,132,199,0.12)",   color: "#075985", border: "rgba(2,132,199,0.25)"   }, // sky
  { bg: "rgba(234,88,12,0.12)",   color: "#9a3412", border: "rgba(234,88,12,0.25)"   }, // orange
];

function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff;
  return h % PALETTE.length;
}

export function badgeStyle(direction) {
  const source = (direction || "").split(/→|->|to /i)[0].trim();
  const entry = PALETTE[hash(source || direction || "")];
  return {
    background: entry.bg,
    color: entry.color,
    border: `1px solid ${entry.border}`,
  };
}
