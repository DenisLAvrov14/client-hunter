import { describe, expect, it } from 'vitest';
import { extractChannels, normalizePhone, telegramValue, whatsappValue } from '../src/contacts/channels.js';
import { buildPageContext } from '../src/inspect/page.js';
import type { PageKind } from '../src/inspect/types.js';

const page = (html: string, kind: PageKind = 'home', url = 'https://acme.co.uk/') => buildPageContext(url, kind, 200, html);
const values = (html: string, kind: PageKind = 'home') => extractChannels([page(html, kind)], 'UK').map((c) => `${c.channel}:${c.value}`);

describe('normalizePhone', () => {
  it('converts to +E.164 only when certain: international prefix or the +7 national format', () => {
    const certain = (value: string) => ({ value, matchKey: value, uncertain: false, note: null });
    expect(normalizePhone('+44 161 496 0000', 'UK')).toEqual(certain('+441614960000'));
    expect(normalizePhone('+44 (0)161 496 0000', 'UK')).toEqual(certain('+441614960000'));
    expect(normalizePhone('0044 161 496 0000', 'UK')).toEqual(certain('+441614960000'));
    expect(normalizePhone('8 (727) 300-00-00', 'KZ')).toEqual(certain('+77273000000'));
    expect(normalizePhone('+7 495 000-00-00', 'RU')).toEqual(certain('+74950000000'));
  });

  it('keeps national-format numbers as published and flags the assumed country', () => {
    expect(normalizePhone('0161 496 0000', 'UK')).toEqual({
      value: '01614960000',
      matchKey: '+441614960000',
      uncertain: true,
      note: 'национальный формат: страна предположительно UK (+44), не подтверждено',
    });
    expect(normalizePhone('020-123 4567', 'NL')).toMatchObject({ value: '0201234567', matchKey: '+31201234567', uncertain: true });
    // A Dublin number on a UK site is NOT turned into a wrong "+44 1 ..." number.
    expect(normalizePhone('01 234 5678', 'UK')).toMatchObject({ value: '012345678', uncertain: true });
  });

  it('flags numbers in an unrecognised format instead of guessing', () => {
    expect(normalizePhone('496 0000 12', 'UK')).toEqual({
      value: '496000012',
      matchKey: '496000012',
      uncertain: true,
      note: 'формат номера не распознан, сохранён как опубликован',
    });
  });

  it('rejects things that cannot be phone numbers', () => {
    expect(normalizePhone('12345', 'UK')).toBeNull();
    expect(normalizePhone('1234567890123456789', 'UK')).toBeNull();
  });
});

describe('extractChannels', () => {
  it('site with only a contact form: the form page URL is the channel', () => {
    const p = page('<form><input name="name"><textarea name="msg"></textarea></form>', 'contact', 'https://acme.co.uk/contact#top');
    expect(extractChannels([p], 'UK')).toEqual([
      {
        channel: 'form',
        value: 'https://acme.co.uk/contact',
        matchKey: 'https://acme.co.uk/contact',
        uncertain: false,
        note: null,
        display: null,
        sourceUrl: 'https://acme.co.uk/contact#top',
      },
    ]);
  });

  it('a login form is not a contact form', () => {
    expect(values('<form><input name="user"><input type="password" name="pw"></form>')).toEqual([]);
  });

  it('site with only a phone: tel: links and labelled numbers on the contact page', () => {
    expect(values('<a href="tel:+441614960000">0161 496 0000</a>')).toEqual(['phone:+441614960000']);
    expect(values('<p>Telephone: 0161 496 0001</p>', 'contact')).toEqual(['phone:01614960001']);
  });

  it('ignores unlabelled numbers and numbers outside contact areas (SKUs, prices, articles)', () => {
    expect(values('<p>Part no. 0161496000 · 4000 units · Tel: 0161 496 0002</p>', 'catalog')).toEqual([]);
    expect(values('<footer>Tel: 0161 496 0003</footer>', 'catalog')).toEqual(['phone:01614960003']);
  });

  it('ignores numbers posted in comments, reviews and quotes', () => {
    const html =
      '<div class="comments"><a href="tel:07700900000">call me</a></div>' +
      '<blockquote><a href="tel:07700900001">x</a></blockquote>' +
      '<section class="review-list">Phone: 07700 900002</section>';
    expect(values(html, 'contact')).toEqual([]);
  });

  it('WhatsApp and Telegram contact links; share buttons and private invites are skipped', () => {
    const html = [
      '<a href="https://wa.me/447700900123">WhatsApp</a>',
      '<a href="https://api.whatsapp.com/send?phone=+44 7700 900124&text=hi">chat</a>',
      '<a href="https://wa.me/?text=look%20at%20this">share</a>',
      '<a href="https://t.me/AcmeSupport">Telegram</a>',
      '<a href="https://t.me/share/url?url=x">share</a>',
      '<a href="https://t.me/+AbCdEf123">private group</a>',
    ].join('');
    expect(values(html)).toEqual([
      'whatsapp:https://wa.me/447700900123',
      'whatsapp:https://wa.me/447700900124',
      'telegram:https://t.me/acmesupport',
    ]);
  });

  it('keeps several different contacts of one company separate', () => {
    const html =
      '<a href="tel:+441614960000">Sales</a><a href="tel:+441614960099">Service</a>' +
      '<a href="https://wa.me/447700900123">WA</a><form><input name="a"><textarea name="b"></textarea></form>';
    expect(values(html, 'contact')).toEqual([
      'form:https://acme.co.uk/',
      'phone:+441614960000',
      'phone:+441614960099',
      'whatsapp:https://wa.me/447700900123',
    ]);
  });

  it('de-duplicates the same number across pages and formats: first source kept, certain value preferred', () => {
    const header = '<header><a href="tel:01614960000">0161 496 0000</a></header>';
    const pages = [
      page(`${header}<p>Welcome</p>`, 'home', 'https://acme.co.uk/'),
      page(`${header}<p>Call +44 161 496 0000 · Tel: +44 (161) 496-0000</p>`, 'contact', 'https://acme.co.uk/contact'),
    ];
    expect(extractChannels(pages, 'UK')).toEqual([
      {
        channel: 'phone',
        value: '+441614960000',
        matchKey: '+441614960000',
        uncertain: false,
        note: null,
        display: '0161 496 0000',
        sourceUrl: 'https://acme.co.uk/',
      },
    ]);
  });

  it('a national number alone stays as published and flagged', () => {
    expect(extractChannels([page('<a href="tel:01614960000">0161 496 0000</a>')], 'UK')).toMatchObject([
      { channel: 'phone', value: '01614960000', matchKey: '+441614960000', uncertain: true },
    ]);
  });

  it('no contacts at all: nothing', () => {
    expect(values('<h1>Bespoke staircases</h1><p>Made in Leeds since 1998.</p>')).toEqual([]);
  });
});

describe('whatsappValue / telegramValue', () => {
  it('accept chat links and WhatsApp Business short links', () => {
    expect(whatsappValue('https://wa.me/message/ABCDEF123')).toBe('https://wa.me/message/ABCDEF123');
    expect(whatsappValue('whatsapp://send?phone=77001234567')).toBe('https://wa.me/77001234567');
    expect(telegramValue('tg://resolve?domain=acme_shop')).toBe('https://t.me/acme_shop');
    expect(telegramValue('https://t.me/s/AcmeNews')).toBe('https://t.me/acmenews');
  });

  it('reject non-contact links', () => {
    expect(whatsappValue('https://www.whatsapp.com/download')).toBeNull();
    expect(telegramValue('https://t.me/joinchat/AAAA')).toBeNull();
    expect(telegramValue('https://telegram.org/apps')).toBeNull();
  });
});
