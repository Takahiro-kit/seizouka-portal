(function(global){
  function p(n){ return String(n).padStart(2,'0'); }

  function parsePortalDateTime(raw){
    if(raw == null || raw === '') return null;
    if(raw instanceof Date && !isNaN(raw.getTime())) return raw;
    const s = String(raw).trim();
    if(!s) return null;
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
    if(m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if(m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
    if(m) return new Date(+m[1], +m[2] - 1, +m[3], 0, 0);
    m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(m) return new Date(+m[1], +m[2] - 1, +m[3], 0, 0);
    if(/^\d{4}-\d{2}-\d{2}T/.test(s) || /^\d{4}\/\d{2}\/\d{2}T/.test(s)){
      const d = new Date(s);
      if(!isNaN(d.getTime())) return d;
    }
    return null;
  }

  function normalizePortalDateValue(raw){
    const d = parsePortalDateTime(raw);
    if(!d) return '';
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }

  function formatPortalDateTimeStorage(d){
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function readPortalDateInputValue(el){
    return normalizePortalDateValue(el ? el.value : '');
  }

  function setPortalDateInputValue(el, raw){
    if(!el) return;
    el.value = normalizePortalDateValue(raw);
  }

  function getTodayIsoDate(){
    return normalizePortalDateValue(new Date());
  }

  function formatPortalDateDisplay(v){
    return normalizePortalDateValue(v);
  }

  function formatPortalDateTimeDisplay(v){
    const d = parsePortalDateTime(v);
    return d ? formatPortalDateTimeStorage(d) : String(v || '').trim();
  }

  function portalNowDateTime(){
    return formatPortalDateTimeStorage(new Date());
  }

  const PORTAL_DATE_INPUT_ATTRS = 'type="date"';

  global.PortalDate = {
    p,
    parsePortalDateTime,
    normalizePortalDateValue,
    formatPortalDateTimeStorage,
    readPortalDateInputValue,
    setPortalDateInputValue,
    getTodayIsoDate,
    formatPortalDateDisplay,
    formatPortalDateTimeDisplay,
    portalNowDateTime,
    PORTAL_DATE_INPUT_ATTRS
  };
})(typeof window !== 'undefined' ? window : globalThis);
