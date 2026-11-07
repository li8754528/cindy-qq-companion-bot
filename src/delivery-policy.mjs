// Only documented structured platform rejections prove the message was not
// accepted. Bare 4xx, duplicate sequence errors and transport faults do not.
const rejectedCodes=new Set([340069,40034005,40034006,40034008,40034009,40034010,40034011,40034024,40034025,40034026,40034027,40034029,40034100,40034101,40034105,40034106,40034127,40034128,40054002,40054003]);
export function rejectedMessage(error,path) {
  return error?.name==='ApiError' && error.path===path && Number.isInteger(error.httpStatus) && error.httpStatus>=400 && error.httpStatus<500 && rejectedCodes.has(error.bizCode) ? {sent:false,outcome:'rejected',code:'QQ_API_'+error.bizCode} : {sent:false,outcome:'uncertain',code:'QQ_SEND_UNCERTAIN'};
}
