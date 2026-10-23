// The Browse Books genre buttons (views/marketing/books.ejs renders them; public/page-books.js reads them back from the
// page): order, label key (g.<slug> in the page's EN/FR dictionaries), tile colours, the search topic each one runs
// (comma-separated words matched against a book's categories; '' = every book) and the icon (24x24 paths, drawn with
// the stroke settings in ICON_ATTRS). The labels themselves live in the page dictionaries, so there is one copy of every text.
const ICON_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';

const GENRES = [
  { slug: 'fiction', key: 'g.fiction', bg: '#f7dcdc', fg: '#a65347', topic: 'fiction',
    svg: '<path d="M12 6.5C10.2 5.2 7.6 4.5 4 4.5v14c3.6 0 6.2.7 8 2 1.8-1.3 4.4-2 8-2v-14c-3.6 0-6.2.7-8 2z"/><path d="M12 6.5v14"/><path d="M6.5 8.5c1.5 0 2.8.3 3.8.8M6.5 11.5c1.5 0 2.8.3 3.8.8M17.5 8.5c-1.5 0-2.8.3-3.8.8M17.5 11.5c-1.5 0-2.8.3-3.8.8"/>' },
  { slug: 'children', key: 'g.children', bg: '#e0ebdc', fg: '#2b2a26', topic: 'juvenile,child,picture book,baby',
    svg: '<path d="M4 18h12"/><path d="M5 18c-1-2-1-4 .5-5.5"/><path d="M15 18c1-2 1-4-.5-5.5"/><path d="M6 13h8.5c1.5 0 2.5-1 2.5-2.5V8.5l2-1.5-2-1-1.2-1.5c-.8 1-1.8 1.5-3 1.5H9c-2 0-3 1.5-3 3.5V13z"/><path d="M8 13l-.5 5M13 13l.5 5"/><circle cx="15" cy="7.2" r=".5" fill="currentColor" stroke="none"/>' },
  { slug: 'ya', key: 'g.ya', bg: '#f4e4d2', fg: '#a65347', topic: 'young adult',
    svg: '<path d="M6 20c1-7 5-12 13-15-1 8-6 12-13 15z"/><path d="M6 20 15 9"/><path d="M9.5 15.5H7M11.5 13v-2.5M11.5 13H14M14 10V8"/>' },
  { slug: 'nonfiction', key: 'g.nonfiction', bg: '#dbe8f0', fg: '#2b2a26', topic: 'nonfiction,non-fiction,history,social science,political,philosophy,psychology,business,education,true crime,nature,religion,language',
    svg: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5c2.5 2.3 3.8 5.2 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.2-3.8-8.5S9.5 5.8 12 3.5z"/>' },
  { slug: 'classics', key: 'g.classics', bg: '#f3d6d1', fg: '#a65347', topic: 'classic',
    svg: '<path d="M4 7.5h14.5a1.5 1.5 0 0 1 0 3H4z"/><path d="M5 10.5h13a1.5 1.5 0 0 1 0 3H5z"/><path d="M4 13.5h14.5a1.5 1.5 0 0 1 0 3H4z"/><path d="M5 16.5h13a1.5 1.5 0 0 1 0 3H5z"/><path d="M6 4.5h12a1.5 1.5 0 0 1 0 3H6z"/>' },
  { slug: 'mystery', key: 'g.mystery', bg: '#e0ebdc', fg: '#2b2a26', topic: 'mystery,thriller,suspense,crime,detective',
    svg: '<circle cx="10" cy="10" r="6"/><path d="M14.5 14.5 20 20"/><path d="M7 9.5a3 3 0 0 1 3-3"/>' },
  { slug: 'romance', key: 'g.romance', bg: '#f7dcdc', fg: '#a65347', topic: 'romance,love',
    svg: '<path d="M12 20s-7.5-4.6-9.5-9.3C1.2 7.3 3.3 4.5 6.3 4.5c2 0 3.8 1.3 5.7 3.5 1.9-2.2 3.7-3.5 5.7-3.5 3 0 5.1 2.8 3.8 6.2C19.5 15.4 12 20 12 20z"/>' },
  { slug: 'biography', key: 'g.biography', bg: '#f7dfe2', fg: '#a65347', topic: 'biography,memoir,autobiography',
    svg: '<circle cx="12" cy="7.5" r="2.6"/><circle cx="6" cy="9" r="2.1"/><circle cx="18" cy="9" r="2.1"/><path d="M7.5 19.5c0-3 2-5.3 4.5-5.3s4.5 2.3 4.5 5.3"/><path d="M2.5 18.5c0-2.4 1.5-4.3 3.5-4.3 1 0 1.8.4 2.4 1"/><path d="M21.5 18.5c0-2.4-1.5-4.3-3.5-4.3-1 0-1.8.4-2.4 1"/>' },
  { slug: 'health', key: 'g.health', bg: '#e0ebdc', fg: '#43523a', topic: 'health,fitness,wellness,self-help,mind,body',
    svg: '<path d="M12 18c-2-2-3-4.5-3-7.5S10 5 12 3.5c2 1.5 3 4 3 7s-1 5.5-3 7.5z"/><path d="M12 18c-3.5 0-6.5-2-8-5 2-.8 4.3-.7 6 .5"/><path d="M12 18c3.5 0 6.5-2 8-5-2-.8-4.3-.7-6 .5"/><path d="M4 18.5h16"/>' },
  { slug: 'arts', key: 'g.arts', bg: '#f4e4d2', fg: '#a65347', topic: 'arts,crafts,hobbies,design,music,photography,antiques,performing',
    svg: '<path d="M12 3.5c-4.8 0-8.5 3.6-8.5 8.2 0 4.2 3.2 7.8 7.2 7.8 1.3 0 1.8-.8 1.8-1.6 0-1.3-1-1.6-1-2.7 0-1 .8-1.7 1.8-1.7h2.2c2.7 0 4.9-2 4.9-4.6C20.4 6.5 16.8 3.5 12 3.5z"/><circle cx="7.8" cy="11" r="1.2"/><circle cx="10" cy="7.3" r="1.2"/><circle cx="14.5" cy="7.3" r="1.2"/><circle cx="17" cy="10.8" r="1.1"/>' },
  { slug: 'travel', key: 'g.travel', bg: '#dbe8f0', fg: '#2b2a26', topic: 'travel',
    svg: '<circle cx="12" cy="12" r="8.5"/><path d="M7 5.5c.5 2 2.2 2.5 3 3.8.8 1.4-.4 2.3.8 3.4 1 1 2.6.2 3.2 1.6.4 1-.6 2.4-.4 3.6"/><path d="M15.5 4.5c-.6 1.3.2 2.3 1.4 2.6 1.3.3 2.5 1 3 2.2"/><path d="M4 13c1.5.2 2.6 1 3 2.5.3 1.2 0 2.5.8 3.5"/>' },
  { slug: 'food', key: 'g.food', bg: '#f7dede', fg: '#a65347', topic: 'cooking,food,drink,wine,recipe,baking',
    svg: '<path d="M7 13.5V20h10v-6.5"/><path d="M7 13.5a4 4 0 0 1-.7-7.9A4.5 4.5 0 0 1 12 3.5a4.5 4.5 0 0 1 5.7 2.1 4 4 0 0 1-.7 7.9z"/><path d="M7 17h10"/>' },
  { slug: 'home', key: 'g.home', bg: '#e0ebdc', fg: '#2b2a26', topic: 'gardening,garden,house,home,interior',
    svg: '<path d="M3.5 11 12 4l8.5 7"/><path d="M5.5 9.5V20h13V9.5"/><path d="M10 20v-5.5h4V20"/><path d="M9 11h6"/>' },
  { slug: 'all', key: 'g.all', bg: '#f6e6d4', fg: '#a65347', topic: '',
    svg: '<path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>' },
];

module.exports = { GENRES, ICON_ATTRS };
