<?php

namespace Tests\Feature\Shared;

use Illuminate\Support\Facades\Route;
use Tests\TestCase;

class ApiThrottleTest extends TestCase
{
    public function test_in_flight_request_consumes_its_slot_before_another_request_enters(): void
    {
        $this->freezeTime();
        $entered = 0;
        $overlap = null;
        Route::post('/api/_probe/overlap', function () use (&$entered, &$overlap) {
            $entered++;
            if ($entered === 1) {
                $overlap = $this->postJson('/api/_probe/overlap');
            }

            return response()->json(['ok' => true]);
        })->middleware('throttle.api:1,1');

        $this->postJson('/api/_probe/overlap')->assertOk();

        $this->assertSame(1, $entered);
        $this->assertNotNull($overlap);
        $overlap->assertStatus(429)
            ->assertHeader('Retry-After', '60')
            ->assertHeader('X-RateLimit-Remaining', '0')
            ->assertExactJson(['message' => 'Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau.']);
    }

    public function test_window_starts_before_processing_and_blocked_requests_do_not_extend_it(): void
    {
        $this->freezeTime();
        Route::post('/api/_probe/slow', function () {
            $this->travel(2)->seconds();

            return response()->json(['ok' => true]);
        })->middleware('throttle.api:1,1');

        $this->postJson('/api/_probe/slow')->assertOk();
        $this->postJson('/api/_probe/slow')->assertStatus(429)->assertHeader('Retry-After', '58');
        $this->travel(30)->seconds();
        $this->postJson('/api/_probe/slow')->assertStatus(429)->assertHeader('Retry-After', '28');
        $this->travel(29)->seconds();
        $this->postJson('/api/_probe/slow')->assertOk();
    }
}
