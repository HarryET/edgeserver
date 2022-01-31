import { Span } from '@sentry/types';
import axios from 'axios';
import FormData from 'form-data';
import { createReadStream } from 'node:fs';
import { statSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';

import { Globals } from '..';
import { log } from '../util/logging';
import { startAction } from '../util/sentry/createChild';
import { FileData, GenericStorage, ResolveData } from './GenericStorage';

export class SignalStorage implements GenericStorage {
    async exists(
        bucket_name: string,
        path: string
    ): Promise<{ type: 'directory' | 'file' } | undefined> {
        const data = await axios.get(
            Globals.SIGNALFS_HOST +
                '/buckets/' +
                bucket_name +
                '/exists?path=' +
                path
        );

        return data.status == 200 ? data.data : undefined;
    }

    async get(
        bucket_name: string,
        path: string
    ): Promise<FileData | undefined> {
        const data = await axios.get(
            Globals.SIGNALFS_HOST +
                '/buckets/' +
                bucket_name +
                '/get?path=' +
                path,
            {
                method: 'get',
                responseType: 'stream',
                validateStatus: (status) => true,
            }
        );

        if (data.status != 200) return;

        return {
            name: '',
            stream: data.data,
            type: data.headers['content-type'],
        };
    }

    async traverse(
        bucket_name: string,
        path: string
    ): Promise<ResolveData | undefined> {
        while (path.length > 0) {
            const indexPath = join(path, '.', 'index.html');
            const data = await axios.get(
                Globals.SIGNALFS_HOST +
                    '/buckets/' +
                    bucket_name +
                    '/get?path=' +
                    indexPath,
                {
                    method: 'get',
                    responseType: 'stream',
                    validateStatus: (status) => true,
                }
            );

            if (data.status === 200)
                return {
                    path: indexPath,
                    file: {
                        name: '',
                        stream: data.data,
                        type: data.headers['content-type'],
                    },
                };

            if (path.length === 1) return;

            path = join(path, '..');
        }
    }

    async put(
        bucket_name: string,
        path: string,
        write: Readable
    ): Promise<void> {
        const f = write;
        const formData = new FormData();

        formData.append('file', f);

        await axios.post(
            Globals.SIGNALFS_HOST +
                '/buckets/' +
                bucket_name +
                '/put?path=' +
                path,
            formData,
            {
                headers: formData.getHeaders(),
                maxBodyLength: Number.POSITIVE_INFINITY,
                maxContentLength: Number.POSITIVE_INFINITY,
            }
        );
    }

    async createBucket(): Promise<string> {
        const request = await axios.post(Globals.SIGNALFS_HOST + '/buckets', {
            validateStatus: false,
        });

        const data = request.data as { bucket_name: string };

        return data.bucket_name;
    }

    async uploadDirectory(
        bucket_name: string,
        prefix: string,
        path: string,
        transaction: Span
    ): Promise<void> {
        // Index
        const file_names = await readdir(path, {
            withFileTypes: true,
            encoding: 'utf-8',
        });

        // Sort it so files get uploaded first, then directories
        const sorted_file_names = file_names.sort(
            (a, b) => +b.isFile() - +a.isFile()
        );

        const actions: (Promise<unknown> | unknown)[] = [];

        log.debug(sorted_file_names.length);

        for (const entry of sorted_file_names) {
            if (entry.isFile()) {
                log.debug(path + entry.name);
                actions.push(
                    startAction(
                        transaction,
                        { op: 'Upload File', description: entry.name },
                        () =>
                            this.put(
                                bucket_name,
                                join(prefix, entry.name),
                                createReadStream(join(path, entry.name))
                            )
                    )
                );
            }

            if (entry.isDirectory()) {
                actions.push(
                    startAction(
                        transaction,
                        {
                            op: 'Upload Directory',
                            description: entry.name,
                        },
                        async (span) =>
                            this.uploadDirectory(
                                bucket_name,
                                join(prefix, entry.name),
                                join(path, entry.name),
                                span
                            )
                    )
                );
            }
        }

        // Execute
        await Promise.allSettled(actions);
    }
}