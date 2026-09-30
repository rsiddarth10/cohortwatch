# ZAP Scanning Report

ZAP by [Checkmarx](https://checkmarx.com/).


## Summary of Alerts

| Risk Level | Number of Alerts |
| --- | --- |
| High | 0 |
| Medium | 2 |
| Low | 0 |
| Informational | 3 |




## Alerts

| Name | Risk Level | Number of Instances |
| --- | --- | --- |
| CSP: style-src unsafe-inline | Medium | 3 |
| ZAP is Out of Date | Medium | 1 |
| Information Disclosure - Suspicious Comments | Informational | 4 |
| Modern Web Application | Informational | 3 |
| Storable and Cacheable Content | Informational | 5 |




## Alert Detail



### [ CSP: style-src unsafe-inline ](https://www.zaproxy.org/docs/alerts/10055/)



##### Medium (High)

### Description

Content Security Policy (CSP) is an added layer of security that helps to detect and mitigate certain types of attacks. Including (but not limited to) Cross Site Scripting (XSS), and data injection attacks. These attacks are used for everything from data theft to site defacement or distribution of malware. CSP provides a set of standard HTTP headers that allow website owners to declare approved sources of content that browsers should be allowed to load on that page — covered types are JavaScript, CSS, HTML frames, fonts, images and embeddable objects such as Java applets, ActiveX, audio and video files.

* URL: http://web:3000
  * Method: `GET`
  * Parameter: `Content-Security-Policy`
  * Attack: ``
  * Evidence: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' http://localhost:3200; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`
  * Other Info: `style-src includes unsafe-inline.`
* URL: http://web:3000/robots.txt
  * Method: `GET`
  * Parameter: `Content-Security-Policy`
  * Attack: ``
  * Evidence: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' http://localhost:3200; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`
  * Other Info: `style-src includes unsafe-inline.`
* URL: http://web:3000/sitemap.xml
  * Method: `GET`
  * Parameter: `Content-Security-Policy`
  * Attack: ``
  * Evidence: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' http://localhost:3200; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'`
  * Other Info: `style-src includes unsafe-inline.`

Instances: 3

### Solution

Ensure that your web server, application server, load balancer, etc. is properly configured to set the Content-Security-Policy header.

### Reference


* [ https://www.w3.org/TR/CSP/ ](https://www.w3.org/TR/CSP/)
* [ https://caniuse.com/#search=content+security+policy ](https://caniuse.com/#search=content+security+policy)
* [ https://content-security-policy.com/ ](https://content-security-policy.com/)
* [ https://github.com/HtmlUnit/htmlunit-csp ](https://github.com/HtmlUnit/htmlunit-csp)
* [ https://developers.google.com/web/fundamentals/security/csp#policy_applies_to_a_wide_variety_of_resources ](https://developers.google.com/web/fundamentals/security/csp#policy_applies_to_a_wide_variety_of_resources)


#### CWE Id: [ 693 ](https://cwe.mitre.org/data/definitions/693.html)


#### WASC Id: 15

#### Source ID: 3

### [ ZAP is Out of Date ](https://www.zaproxy.org/docs/alerts/10116/)



##### Medium (High)

### Description

The version of ZAP you are using to test your app is out of date and is no longer being updated.
The risk level is set based on how out of date your ZAP version is.

* URL: http://web:3000/assets/index-CoPuv4hk.css
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: ``
  * Other Info: `The latest version of ZAP is 2.17.0`

Instances: 1

### Solution

Download the latest version of ZAP from https://www.zaproxy.org/download/ and install it.

### Reference


* [ https://www.zaproxy.org/download/ ](https://www.zaproxy.org/download/)


#### CWE Id: [ 1104 ](https://cwe.mitre.org/data/definitions/1104.html)


#### WASC Id: 45

#### Source ID: 3

### [ Information Disclosure - Suspicious Comments ](https://www.zaproxy.org/docs/alerts/10027/)



##### Informational (Low)

### Description

The response appears to contain suspicious comments which may help an attacker. Note: Matches made within script blocks or files are against the entire content not only comments.

* URL: http://web:3000/assets/index-BQSAv8rb.js
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `db`
  * Other Info: `The following pattern was used: \bDB\b and was detected 2 times, the first in the element starting with: "In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}function v_(e,t){if(e){if(typeof e==`string", see evidence field for the suspicious comment/snippet.`
* URL: http://web:3000/assets/index-BQSAv8rb.js
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `from`
  * Other Info: `The following pattern was used: \bFROM\b and was detected 18 times, the first in the element starting with: "In order to be iterable, non-array objects must have a [Symbol.iterator]() method.`)}function Dc(e,t){if(e){if(typeof e==`string", see evidence field for the suspicious comment/snippet.`
* URL: http://web:3000/assets/index-BQSAv8rb.js
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `query`
  * Other Info: `The following pattern was used: \bQUERY\b and was detected in the element starting with: "Please change the parent <Route path="${e}"> to <Route path="${e===`/`?`*`:`${e}/*`}">.`)}let u=pt(),d;if(t){let e=typeof t==`st", see evidence field for the suspicious comment/snippet.`
* URL: http://web:3000/assets/index-BQSAv8rb.js
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `select`
  * Other Info: `The following pattern was used: \bSELECT\b and was detected 2 times, the first in the element starting with: "`+e.stack}}var Re=Object.prototype.hasOwnProperty,ze=t.unstable_scheduleCallback,Be=t.unstable_cancelCallback,Ve=t.unstable_shou", see evidence field for the suspicious comment/snippet.`

Instances: 4

### Solution

Remove all comments that return information that may help an attacker and fix any underlying problems they refer to.

### Reference



#### CWE Id: [ 200 ](https://cwe.mitre.org/data/definitions/200.html)


#### WASC Id: 13

#### Source ID: 3

### [ Modern Web Application ](https://www.zaproxy.org/docs/alerts/10109/)



##### Informational (Medium)

### Description

The application appears to be a modern web application. If you need to explore it automatically then the Ajax Spider may well be more effective than the standard one.

* URL: http://web:3000
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `<script type="module" crossorigin src="/assets/index-BQSAv8rb.js"></script>`
  * Other Info: `No links have been found while there are scripts, which is an indication that this is a modern web application.`
* URL: http://web:3000/robots.txt
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `<script type="module" crossorigin src="/assets/index-BQSAv8rb.js"></script>`
  * Other Info: `No links have been found while there are scripts, which is an indication that this is a modern web application.`
* URL: http://web:3000/sitemap.xml
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: `<script type="module" crossorigin src="/assets/index-BQSAv8rb.js"></script>`
  * Other Info: `No links have been found while there are scripts, which is an indication that this is a modern web application.`

Instances: 3

### Solution

This is an informational alert and so no changes are required.

### Reference




#### Source ID: 3

### [ Storable and Cacheable Content ](https://www.zaproxy.org/docs/alerts/10049/)



##### Informational (Medium)

### Description

The response contents are storable by caching components such as proxy servers, and may be retrieved directly from the cache, rather than from the origin server by the caching servers, in response to similar requests from other users. If the response data is sensitive, personal or user-specific, this may result in sensitive information being leaked. In some cases, this may even result in a user gaining complete control of the session of another user, depending on the configuration of the caching components in use in their environment. This is primarily an issue where "shared" caching servers such as "proxy" caches are configured on the local network. This configuration is typically found in corporate or educational environments, for instance.

* URL: http://web:3000
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: ``
  * Other Info: `In the absence of an explicitly specified caching lifetime directive in the response, a liberal lifetime heuristic of 1 year was assumed. This is permitted by rfc7234.`
* URL: http://web:3000/assets/index-BQSAv8rb.js
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: ``
  * Other Info: `In the absence of an explicitly specified caching lifetime directive in the response, a liberal lifetime heuristic of 1 year was assumed. This is permitted by rfc7234.`
* URL: http://web:3000/assets/index-CoPuv4hk.css
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: ``
  * Other Info: `In the absence of an explicitly specified caching lifetime directive in the response, a liberal lifetime heuristic of 1 year was assumed. This is permitted by rfc7234.`
* URL: http://web:3000/robots.txt
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: ``
  * Other Info: `In the absence of an explicitly specified caching lifetime directive in the response, a liberal lifetime heuristic of 1 year was assumed. This is permitted by rfc7234.`
* URL: http://web:3000/sitemap.xml
  * Method: `GET`
  * Parameter: ``
  * Attack: ``
  * Evidence: ``
  * Other Info: `In the absence of an explicitly specified caching lifetime directive in the response, a liberal lifetime heuristic of 1 year was assumed. This is permitted by rfc7234.`

Instances: 5

### Solution

Validate that the response does not contain sensitive, personal or user-specific information. If it does, consider the use of the following HTTP response headers, to limit, or prevent the content being stored and retrieved from the cache by another user:
Cache-Control: no-cache, no-store, must-revalidate, private
Pragma: no-cache
Expires: 0
This configuration directs both HTTP 1.0 and HTTP 1.1 compliant caching servers to not store the response, and to not retrieve the response (without validation) from the cache, in response to a similar request.

### Reference


* [ https://datatracker.ietf.org/doc/html/rfc7234 ](https://datatracker.ietf.org/doc/html/rfc7234)
* [ https://datatracker.ietf.org/doc/html/rfc7231 ](https://datatracker.ietf.org/doc/html/rfc7231)
* [ https://www.w3.org/Protocols/rfc2616/rfc2616-sec13.html ](https://www.w3.org/Protocols/rfc2616/rfc2616-sec13.html)


#### CWE Id: [ 524 ](https://cwe.mitre.org/data/definitions/524.html)


#### WASC Id: 13

#### Source ID: 3


