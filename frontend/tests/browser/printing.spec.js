import {test,expect} from '@playwright/test';

test('saved receipt document settings survive later restaurant changes',async({page})=>{
  await page.goto('/login');
  const result=await page.evaluate(async()=>{
    const {receiptModel,buildReceipt}=await import('/src/modules/restaurant/orders/services/receipt.js');
    const bill={billNumber:'SAVED-DOCUMENT',totalAmount:100,subtotal:100,taxAmount:0,items:[],
      receiptSettings:{documentType:'bill_of_supply',receiptLogoPath:null,compositionNote:'Saved declaration'}};
    const options={settings:{documentType:'tax_invoice',compositionNote:'Changed declaration',receiptLogoPath:'/changed-logo.png'}};
    return {title:receiptModel(bill,options).title,html:buildReceipt(bill,options)};
  });
  expect(result.title).toBe('Bill of Supply');
  expect(result.html).toContain('Saved declaration');
  expect(result.html).not.toContain('Changed declaration');
  expect(result.html).not.toContain('/changed-logo.png');
});

for(const paper of ['58mm','80mm','a4']){
  test(`receipt layout and print cleanup ${paper}`,async({page},testInfo)=>{
    await page.goto('/login');
    await page.emulateMedia({media:'print'});
    await page.evaluate(async(paper)=>{
      window.print=()=>{window.printInvocations=(window.printInvocations||0)+1;};
      const {printBill}=await import('/src/modules/restaurant/orders/services/receipt.js');
      printBill({billNumber:'TEST-PRINT',orderNumber:'TEST-ORDER',printCount:2,
        billedAt:'2026-09-30T05:00:00Z',subtotal:4000,totalAmount:4200,paidAmount:4200,
        taxAmount:200,billStatus:'paid',items:Array.from({length:40},(_,i)=>({
          itemName:`Dish ${i+1} <b>Paneer</b> with a long description`,quantity:1,lineSubtotal:100,
        })),payments:[{paymentMethod:'cash',amount:2000},{paymentMethod:'upi',amount:2200}],
        taxes:[{taxPercentage:5,taxableAmount:4000,cgst:100,sgst:100,cgstRate:2.5,sgstRate:2.5}],
      },{restaurantName:'Printer test restaurant',settings:{printPaperWidth:paper,printCopies:1}});
    },paper);
    const root=page.locator('#print-root');
    await expect(root).toContainText('TEST-PRINT');
    await expect(root).toContainText('DUPLICATE');
    await expect(root).toContainText('Dish 40');
    await expect(root.locator('b')).toHaveCount(0);
    expect(await page.evaluate(()=>window.printInvocations)).toBe(1);
    const size=await root.evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
    expect(size.scroll).toBeLessThanOrEqual(size.width+1);
    if(paper!=='a4')expect(size.width).toBeLessThanOrEqual((parseInt(paper,10)-8)*96/25.4);
    await page.pdf({path:testInfo.outputPath(`receipt-${paper}.pdf`),
      ...(paper==='a4'?{format:'A4'}:{width:paper,height:'600mm'}),printBackground:true});
    await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
    await expect(root).toHaveCount(0);
    expect(await page.locator('html').getAttribute('class')).not.toContain('is-printing');
  });
}
