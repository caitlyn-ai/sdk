// The code blocks' colours, on cover-ground (#0a0c0b) in both site themes, from the design system's palette 4.1.
// Each kind of token has its own restrained hue, and every one is above 7:1 on cover-ground:
//   keywords and storage        amber-primary (#ffbb26)
//   strings                     field-accent-01 (#c2ffa5)
//   types, classes, namespaces  clay-primary (#f6a679)
//   numbers and constants       amber-accent-01 (#ff9207)
//   function names              clay-accent-01 (#ffe3d2)
//   property names, keys        field-primary (#a3af64)
//   comments                    cover-muted (#a8b0ad), italic
//   punctuation and operators   cover-muted
//   everything else             cover-ink (#ffffff)
// GAP: the system has no code colours; these are its palette tokens given one job each.
import { ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';

const ink = '#ffffff'; // cover-ink
const muted = '#a8b0ad'; // cover-muted
const ground = '#0a0c0b'; // cover-ground
const amber = '#ffbb26'; // amber-primary
const amberAccent = '#ff9207'; // amber-accent-01
const field = '#a3af64'; // field-primary
const fieldAccent = '#c2ffa5'; // field-accent-01
const clay = '#f6a679'; // clay-primary
const clayAccent = '#ffe3d2'; // clay-accent-01

export const caitlynCodeTheme = new ExpressiveCodeTheme({
  name: 'caitlyn',
  type: 'dark',
  colors: {
    'editor.background': ground,
    'editor.foreground': ink,
  },
  tokenColors: [
    { settings: { foreground: ink } },
    { scope: ['punctuation', 'meta.brace', 'keyword.operator', 'punctuation.separator', 'punctuation.terminator', 'punctuation.accessor'], settings: { foreground: muted } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: muted, fontStyle: 'italic' } },
    { scope: ['string', 'string.quoted', 'string.template', 'punctuation.definition.string', 'markup.inline.raw'], settings: { foreground: fieldAccent } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other', 'support.constant', 'variable.other.constant'], settings: { foreground: amberAccent } },
    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new', 'keyword.operator.expression', 'keyword.other', 'variable.language'],
      settings: { foreground: amber },
    },
    {
      scope: ['entity.name.type', 'entity.name.class', 'entity.other.inherited-class', 'support.type', 'support.class', 'entity.name.namespace', 'entity.name.type.module'],
      settings: { foreground: clay },
    },
    { scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'variable.function'], settings: { foreground: clayAccent } },
    {
      scope: ['support.type.property-name', 'meta.object-literal.key', 'variable.other.property', 'variable.object.property', 'entity.name.tag', 'entity.other.attribute-name', 'meta.mapping.key string'],
      settings: { foreground: field },
    },
  ],
});
