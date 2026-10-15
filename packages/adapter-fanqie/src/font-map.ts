/** Mapping for the observed Fanqie reader font dc027189e0ba4cd.woff2.
 * Decimal PUA/codepoint associations were cross-checked against
 * https://github.com/romcere/fanqienovel-decryptor/blob/main/dicts/font_map.py
 * and the current font's 362-character cmap. U+FFFD marks unused slots.
 */
const firstCodepoint = 58344;
const mappedCharacters = "D在主特家军然表场4要只v和�6别还g现儿岁��此象月3出战工相o男直失世F都平文什VO将真T那当�会立些u是十张学气大爱两命全后东性通被1它乐接而感车山公了常以何可话先pi叫轻M士w着变尔快l个说少色里安花远7难师放t报认面道S�克地度I好机U民写把万同水新没书电吃像斯5为y白几日教看但第加候作上拉住有法r事应位利你声身国问马女他Y比父xAHNsX边美对所金活回意到z从j知又内因点Q三定8Rb正或夫向德听更�得告并本q过记L让打f人就者去原满体做经K走如孩cG给使物�最笑部�员等受k行一条果动光门头见往自解成处天能于名其发总母的死手入路进心来h时力多开已许d至由很界n小与Z想代么分生口再妈望次西风种带J�实情才这�E我神格长觉间年眼无不亲关结0友信下却重己老2音字m呢明之前高PB目太e9起稜她也W用方子英每理便四数期中C外样a海们任";
export const FANQIE_FONT_FILE = 'dc027189e0ba4cd.woff2';
export const FANQIE_FONT_FAMILY = 'DNMrHsV173Pd4pgy';

export function decodeFanqieText(value: string): string {
  return Array.from(value, char => {
    const codepoint = char.codePointAt(0)!;
    if (codepoint < 0xe000 || codepoint > 0xf8ff) return char;
    const mapped = mappedCharacters[codepoint - firstCodepoint];
    if (!mapped || mapped === '\uFFFD') throw new Error('fanqie-font-unrecognized');
    return mapped;
  }).join('');
}
