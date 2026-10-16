/**
 * Detect the language of the user's recent messages so the suggestion is
 * written in the same language (Chinese conversation -> Chinese suggestion).
 *
 * No pi imports — unit-testable with plain Node.
 *
 * @module
 */

export type LangCode = "zh-Hans" | "zh-Hant" | "ja" | "ko" | "en" | "unknown";

const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HANGUL = /\p{Script=Hangul}/u;
const LATIN = /\p{Script=Latin}/u;

// Characters that only appear in one of the two Chinese scripts (small, common sample).
const TRAD_ONLY = /[們這個說會來時國對沒為後還開裡發現與點樣麼嗎請經過應關問頭見買話讓記錄檔試]/u;
const SIMP_ONLY = /[们这个说会来时国对没为后还开里发现与点样么吗请经过应关问头见买话让记录档试]/u;

export interface LangCounts {
	han: number;
	kana: number;
	hangul: number;
	latin: number;
	trad: number;
	simp: number;
}

export function countScripts(text: string): LangCounts {
	const c: LangCounts = { han: 0, kana: 0, hangul: 0, latin: 0, trad: 0, simp: 0 };
	for (const ch of text) {
		if (KANA.test(ch)) c.kana++;
		else if (HAN.test(ch)) {
			c.han++;
			if (TRAD_ONLY.test(ch)) c.trad++;
			else if (SIMP_ONLY.test(ch)) c.simp++;
		} else if (HANGUL.test(ch)) c.hangul++;
		else if (LATIN.test(ch)) c.latin++;
	}
	return c;
}

/**
 * Classify recent user text. CJK characters carry more meaning per char than
 * Latin letters (and code/paths inflate Latin counts), so a CJK char is
 * weighted ~4x a Latin letter.
 */
export function detectLanguage(texts: readonly string[]): LangCode {
	const c = countScripts(texts.join("\n"));
	const cjk = c.han + c.kana + c.hangul;
	if (cjk === 0 && c.latin === 0) return "unknown";
	if (cjk * 4 >= c.latin) {
		if (c.kana > 0 && c.kana * 5 >= c.han) return "ja";
		if (c.hangul > c.han) return "ko";
		if (c.han > 0) return c.trad > c.simp ? "zh-Hant" : "zh-Hans";
	}
	return c.latin > 0 ? "en" : "unknown";
}

const NAMES: Record<Exclude<LangCode, "unknown">, string> = {
	"zh-Hans": "Simplified Chinese (简体中文)",
	"zh-Hant": "Traditional Chinese (繁體中文)",
	ja: "Japanese (日本語)",
	ko: "Korean (한국어)",
	en: "English",
};

/** Instruction line for the prompt, or "" when unknown. */
export function languageInstruction(lang: LangCode): string {
	if (lang === "unknown") return "Write the suggestion in the same language the user writes in.";
	return `The user writes in ${NAMES[lang]}. Write the suggestion in ${NAMES[lang]}, matching their wording style. Keep code identifiers, file names and commands as-is.`;
}
