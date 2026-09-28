// A tiny practice copy of Apple's pickup checkout, used to test the checkout steps offline.
const page = (title, body, script = '') => `<!doctype html><html><head><title>${title}</title></head><body>
<h1>${title}</h1>${body}
<script>
const save = (k, v) => { const s = JSON.parse(localStorage.getItem('order') || '{}'); s[k] = v; localStorage.setItem('order', JSON.stringify(s)); };
const fields = (...ids) => ids.forEach((id) => save(id, document.getElementById(id).value));
${script}
</script></body></html>`;

const radios = (name, opts) => opts.map((o) => `<label><input type="radio" name="${name}" value="${o}"> ${o}</label>`).join('<br>');

export const PAGES = {
  '/shop/buy-iphone/iphone-18-pro': page('Buy iPhone 18 Pro', `
    <fieldset>${radios('model', ['iPhone 18 Pro 6.3-inch display', 'iPhone 18 Pro Max 6.9-inch display'])}</fieldset>
    <fieldset>${radios('color', ['Silver', 'Black', 'Glacier', 'Burgundy'])}</fieldset>
    <fieldset>${radios('cap', ['256GB', '512GB', '1TB', '2TB'])}</fieldset>
    <fieldset>${radios('trade', ['Select a smartphone', 'No trade-in'])}</fieldset>
    <fieldset>${radios('pay', ['Buy', 'Finance'])}</fieldset>
    <fieldset>${radios('carrier', ['AT&T', 'Verizon', 'Connect on your own later'])}</fieldset>
    <fieldset>${radios('care', ['AppleCare+', 'No AppleCare coverage'])}</fieldset>
    <button id="add" disabled>Add to Bag</button>`, `
    const names = ['model','color','cap','trade','pay','carrier','care'];
    document.body.addEventListener('change', () => {
      document.getElementById('add').disabled = !names.every((n) => document.querySelector('input[name=' + n + ']:checked'));
    });
    document.getElementById('add').onclick = () => {
      localStorage.clear();
      names.forEach((n) => save(n, document.querySelector('input[name=' + n + ']:checked').value));
      location.href = '/shop/bag';
    };`),
  '/shop/bag': page('Bag', '<button onclick="location.href=\'/shop/signin\'">Check Out</button>'),
  '/shop/signin': page('Sign in', '<button onclick="location.href=\'/shop/checkout/fulfillment\'">Continue as Guest</button>'),
  '/shop/checkout/fulfillment': page('Delivery or pickup', `
    ${radios('ful', ["I'd like it delivered", "I'll pick it up"])}
    <div id="pick" hidden>
      <label for="zip">Enter a ZIP Code</label><input id="zip">
      <div id="stores" hidden>${radios('store', ['Apple Stanford', 'Apple Valley Fair'])}
        <label for="time">Pickup time</label>
        <select id="time"><option value="">Select</option><option value="t1">Today 5-5:15 PM</option></select></div>
      <button id="cont">Continue to Pickup Details</button>
    </div>`, `
    document.body.addEventListener('change', () => {
      document.getElementById('pick').hidden = !document.querySelector('input[value="I\\'ll pick it up"]:checked');
    });
    document.getElementById('zip').onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('stores').hidden = false; };
    document.getElementById('cont').onclick = () => {
      save('store', document.querySelector('input[name=store]:checked')?.value); fields('time', 'zip');
      location.href = '/shop/checkout/pickup';
    };`),
  '/shop/checkout/pickup': page('Who will pick up', `
    <label for="fn">First Name</label><input id="fn"><label for="ln">Last Name</label><input id="ln">
    <label for="em">Email Address</label><input id="em"><label for="ph">Phone Number</label><input id="ph">
    <button id="cont">Continue to Payment</button>`, `
    document.getElementById('cont').onclick = () => { fields('fn','ln','em','ph'); location.href = '/shop/checkout/payment'; };`),
  '/shop/checkout/payment': page('Payment', `
    ${radios('method', ['Apple Pay', 'Credit or Debit Card'])}
    <label for="cc">Credit/Debit Card Number</label><input id="cc">
    <label for="exp">Expiration MM/YY</label><input id="exp">
    <label for="cvv">CVV</label><input id="cvv">
    <label for="bfn">First Name</label><input id="bfn"><label for="bln">Last Name</label><input id="bln">
    <label for="st">Street Address</label><input id="st">
    <label for="bzip">ZIP Code</label><input id="bzip"><label for="city">City</label><input id="city">
    <label for="state">State</label><select id="state"><option>AL</option><option>CA</option></select>
    <button id="cont">Continue to Review</button>`, `
    document.getElementById('cont').onclick = () => {
      save('method', document.querySelector('input[name=method]:checked')?.value);
      fields('cc','exp','cvv','bfn','bln','st','bzip','city','state'); location.href = '/shop/checkout/review';
    };`),
  '/shop/checkout/review': page('Review', '<button onclick="location.href=\'/shop/checkout/thankyou\'">Place Your Order</button>'),
  '/shop/checkout/thankyou': page('Thank you', '<p>Your order number is W123456789.</p><pre id="order"></pre>',
    "document.getElementById('order').textContent = localStorage.getItem('order');"),
};
