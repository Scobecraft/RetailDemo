package de.retaildemo.demo

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val app = applicationContext.demoApp
        if (app.sync.isDue()) app.sync.syncNow()
        return Result.success()
    }
}
