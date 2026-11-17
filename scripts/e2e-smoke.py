import subprocess, time, os, sys
from playwright.sync_api import sync_playwright, expect
env=dict(os.environ, PORT='3111', DATA_DIR='/tmp/rode-e2e-data', ADMIN_PASSWORD='Salon-Passw0rd!', LOG_LEVEL='warn')
srv=subprocess.Popen(['node','src/server.js'],cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),env=env)
time.sleep(1.5)
errors=[]
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':1100,'height':900}); pg=ctx.new_page()
    pg.on('pageerror',lambda e: errors.append('pageerror: '+str(e)))
    pg.on('console',lambda m: errors.append('console.'+m.type+': '+m.text) if (m.type in('error','warning') and '401' not in m.text) else None)
    pg.route('**/fonts.googleapis.com/**',lambda r:r.fulfill(status=200,content_type='text/css',body=''))
    base='http://127.0.0.1:3111'
    pg.goto(base+'/')
    expect(pg.locator('#loginForm')).to_be_visible()
    # wrong password
    pg.fill('#lUser','admin'); pg.fill('#lPass','wrong-password-1'); pg.click('#lGo')
    expect(pg.locator('#loginMsg')).to_contain_text('Incorrect')
    pg.fill('#lPass','Salon-Passw0rd!'); pg.click('#lGo')
    expect(pg.locator('#app')).to_be_visible()
    expect(pg.locator('.tabs a:visible')).to_have_count(6)
    print('admin sees tabs:',pg.locator('.tabs a:visible').all_inner_texts())
    # sample data
    pg.click('#emptyHint button[data-act=sample]')
    expect(pg.locator('#sampleBanner')).to_be_visible()
    assert pg.inner_text('#kInc').strip() not in ('','0'), pg.inner_text('#kInc')
    print('income after sample:',pg.inner_text('#kInc'))
    pg.click('#sampleBanner button[data-act=clearSample]')
    expect(pg.locator('#sampleBanner')).to_be_hidden()
    # create customer
    pg.click('.tabs a[data-v=users]')
    expect(pg.locator('#v-users')).to_be_visible()
    pg.fill('#uName','Nimali Perera'); pg.fill('#uUser','nimali'); pg.fill('#uPhone','0771234567')
    assert pg.input_value('#uRole')=='customer'
    pg.click('#v-users [data-act=genPass]')
    temp=pg.input_value('#uPass'); assert len(temp)==14
    pg.click('#uSubmit')
    expect(pg.locator('#uCreated')).to_contain_text('nimali')
    expect(pg.locator('#userList')).to_contain_text('Nimali Perera')
    print('created customer, temp pw len',len(temp))
    # duplicate username shows an inline error
    pg.fill('#uName','Dup'); pg.fill('#uUser','nimali'); pg.fill('#uPass','Another-Passw0rd!'); pg.click('#uSubmit')
    expect(pg.locator('#uWarn')).to_contain_text('already in use')
    # admin books and takes payment
    pg.click('.tabs a[data-v=book]')
    pg.fill('#aClient','Walk In'); pg.select_option('#aService','s3'); pg.fill('#aTime','10:00')
    pg.click('#aSubmit')
    expect(pg.locator('#dayList')).to_contain_text('Walk In')
    pg.click('#dayList [data-act=pay][data-m=cash]')
    expect(pg.locator('#dayList')).to_contain_text('recorded')
    pg.click('.tabs a[data-v=money]')
    expect(pg.locator('#txnList')).to_contain_text('Gel polish')
    # sign out via account dialog
    pg.click('#acctBtn'); pg.click('#acct [data-act=signout]')
    expect(pg.locator('#loginForm')).to_be_visible()
    assert pg.inner_html('#txnList')=='' , 'ledger DOM must be wiped on sign out'
    # customer: forced password change
    pg.fill('#lUser','nimali'); pg.fill('#lPass',temp); pg.click('#lGo')
    expect(pg.locator('#forceForm')).to_be_visible()
    pg.fill('#fCur',temp); pg.fill('#fNew','Mine-Own-Passw0rd'); pg.fill('#fNew2','Mine-Own-Passw0rd'); pg.click('#fGo')
    expect(pg.locator('#app')).to_be_visible()
    tabs=pg.locator('.tabs a:visible').all_inner_texts(); print('customer tabs:',tabs)
    assert [t.strip() for t in tabs]==['My bookings','My inspo'], tabs
    # direct navigation to a forbidden view is redirected
    pg.goto(base+'/#money'); pg.reload()
    expect(pg.locator('#v-book')).to_be_visible(); assert pg.evaluate('location.hash')=='#book'
    expect(pg.locator('#v-users')).to_be_hidden()
    assert pg.input_value('#aClient')=='Nimali Perera' and pg.eval_on_selector('#aClient','e=>e.readOnly')
    assert pg.eval_on_selector('#aService','e=>[...e.options].every(o=>o.value!=="custom")')
    # customer books for tomorrow with a photo
    import datetime
    tomorrow=(datetime.date.today()+datetime.timedelta(days=1)).isoformat()
    pg.fill('#aDate',tomorrow); pg.select_option('#aService','s1'); pg.fill('#aTime','11:00')
    assert pg.input_value('#aPrice')=='2500'
    pg.set_input_files('#aFiles','/tmp/pink.png')
    pg.fill('#aNote','pink chrome please'); pg.click('#aSubmit')
    pg.click('[data-act=dnext]') if False else None
    pg.evaluate("document.querySelector('#aDate').value")
    pg.click('#weekStrip [aria-pressed=true]')  # stays on that day
    expect(pg.locator('#dayList')).to_contain_text('Nimali Perera', timeout=8000)
    expect(pg.locator('#dayList')).to_contain_text('pink chrome please')
    expect(pg.locator('#dayList .appt [data-act=pay]')).to_have_count(0)
    expect(pg.locator('#dayList .appt [data-act=delAppt]')).to_have_count(0)
    pg.wait_for_selector('#dayList .th img')
    pg.wait_for_function("document.querySelector('#dayList .th img').naturalWidth>0")
    print('customer booked with photo, image loads')
    # inspo tab
    pg.click('.tabs a[data-v=inspo]'); expect(pg.locator('#inspoWrap')).to_contain_text('Nimali Perera')
    # double booking at the same time is blocked (own overlap)
    pg.click('.tabs a[data-v=book]')
    pg.fill('#aDate',tomorrow); pg.select_option('#aService','s1'); pg.fill('#aTime','11:15'); pg.click('#aSubmit')
    expect(pg.locator('#aWarn')).to_be_visible()
    # cancel own booking (two-step not required)
    pg.click('#dayList [data-act=cancel]')
    expect(pg.locator('#dayList .pill.cancelled')).to_be_visible()
    pg.click('#acctBtn'); pg.click('#acct [data-act=signout]')
    # admin sees customer's booking and photo
    pg.fill('#lUser','admin'); pg.fill('#lPass','Salon-Passw0rd!'); pg.click('#lGo')
    pg.click('.tabs a[data-v=inspo]'); expect(pg.locator('#inspoWrap')).to_contain_text('Nimali Perera')
    pg.wait_for_function("document.querySelector('#inspoWrap img').naturalWidth>0")
    # admin edits the customer's access: remove photo access
    pg.click('.tabs a[data-v=users]')
    pg.click('#userList [data-act=uedit]:visible >> nth=0') if False else None
    card=pg.locator('#userList .ucard',has_text='Nimali Perera')
    card.locator('[data-act=uedit]').click()
    pg.locator('#userList form[data-uedit] select[data-sec=inspo]').select_option('none')
    pg.click('#userList form[data-uedit] button[type=submit]')
    expect(pg.locator('#userList')).to_contain_text('Bookings: own only')
    # deactivate
    pg.locator('#userList .ucard',has_text='Nimali Perera').locator('[data-act=utoggle]').click()
    expect(pg.locator('#userList')).to_contain_text('Inactive')
    # mobile layout sanity
    pg.set_viewport_size({'width':390,'height':800}); pg.click('.tabs a[data-v=overview]')
    ow=pg.evaluate('document.documentElement.scrollWidth'); print('mobile scrollWidth',ow); assert ow<=392
    b.close()
finally:
  srv.terminate(); srv.wait()
print('CONSOLE/PAGE ERRORS:',errors)
sys.exit(1 if errors else 0)
