import { Controller, Get, Redirect } from '@nestjs/common';

@Controller()
export class HomeController {
  @Get()
  @Redirect('/api/docs', 302)
  home() {}
}
