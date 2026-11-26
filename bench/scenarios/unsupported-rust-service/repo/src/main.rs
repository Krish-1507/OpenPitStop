use actix_web::{web, HttpResponse};

pub async fn user(path: web::Path<String>) -> HttpResponse {
    let id = path.into_inner();
    let query = format!("SELECT * FROM users WHERE id = {}", id);
    HttpResponse::Ok().body(query)
}
