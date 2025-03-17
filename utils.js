
module.exports = {
    findStore: async function (lat, lon) {
        const response = await fetch(`https://services${process.env.WALGREENS_SANDBOX_CODE||""}.walgreens.com/api/photo/store/v3`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                apiKey: process.env.WALGREENS_API_KEY,
                affId: 'photoapi',
                latitude: lat,
                longitude: lon,
                act: 'photoStores',
                appVer: '1.0',
                devInf: 'Pixel 8 Pro',
                productDetails: [
                    {
                        productId: '6560003',
                        qty: '10'
                    }
                ]
            })
        });

        if (!response.ok)  throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        return data;
    },
    orderStatus: async function (id) {
        const response = await fetch(`https://services${process.env.WALGREENS_SANDBOX_CODE||""}.walgreens.com/api/photo/order/status/v3`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                "apiKey":process.env.WALGREENS_API_KEY, 
                "affId":"photoapi", 
                "orders": [id], 
                "act": "orderstatus", 
                "appVer":"1.0", 
                "devInf":"Pixel 8 Pro" 
            })
        });

        if (!response.ok)  throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        return data;
    },
    printPhotos: async function (order) {       
        const response = await fetch(`https://services${process.env.WALGREENS_SANDBOX_CODE||""}.walgreens.com/api/photo/order/submit/v3`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                apiKey: process.env.WALGREENS_API_KEY,
                affId: "photoapi",
                firstName: order.firstName,
                lastName: order.lastName,
                phone: order.phoneNumber,
                email: order.email,
                storeNum: order.storeNumber,
                promiseTime: order.promiseTime,
                affNotes: "TRACKING ID FOR YOUR LOGS",
                act: "submitphotoorder",
                appVer: "1.0",
                devInf: "Pixel 8 Pro",
                productDetails: [
                    {
                        productId: "6560003",
                        imageDetails:  order.photos.split(",").map(photo => {
                            return {
                                qty: 1,
                                url: photo,
                            }
                        }),
                    },
                ],
            })
        });

        if (!response.ok)  throw new Error(`HTTP error! status: ${response.status}`);

        const data = await response.json();
        return data;
    },
}