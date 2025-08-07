// models/ModelManager.js - Complete integration with Hugging Face and fixed preprocessing
const ort = require('onnxruntime-node');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const https = require('https');

class ModelManager {
    constructor() {
        this.sessionONNX = null;
        this.modelLoadAttempts = 0;
        this.maxLoadAttempts = 3;
        this.isLoading = false;
        
        // Your Hugging Face model URL
        this.modelPath = 'https://huggingface.co/syntichemusawu/MalariaD/resolve/main/eyelid_anemia_model.onnx';
        
        // Cache directory for downloaded model
        this.cacheDir = path.join(__dirname, '.cache');
        this.cachedModelPath = path.join(this.cacheDir, 'eyelid_anemia_model.onnx');
        
        // Local fallback path
        this.localModelPath = path.join(__dirname, 'eyelid_anemia_model.onnx');
    }

    async initialize() {
        console.log('🚀 Initializing ModelManager with Hugging Face model...');
        
        // Create cache directory if it doesn't exist
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
            console.log('✅ Created cache directory');
        }

        // Load the model
        await this.loadModel();
        
        return this.getModelStatus();
    }

    async loadModel() {
        if (this.isLoading) {
            console.log('🔄 Model loading already in progress...');
            return this.waitForLoad();
        }

        this.modelLoadAttempts++;
        this.isLoading = true;
        
        console.log(`🔄 Attempting to load model (attempt ${this.modelLoadAttempts}/${this.maxLoadAttempts})`);
        
        try {
            // Try to load from cache first
            if (fs.existsSync(this.cachedModelPath)) {
                console.log('📦 Loading model from cache...');
                const stats = fs.statSync(this.cachedModelPath);
                console.log('📊 Cached model info:', {
                    path: this.cachedModelPath,
                    size: stats.size,
                    sizeInMB: (stats.size / (1024 * 1024)).toFixed(2),
                    modified: stats.mtime
                });

                this.sessionONNX = await ort.InferenceSession.create(this.cachedModelPath, {
                    executionProviders: ['cpu'],
                    logSeverityLevel: 0
                });
                
                console.log('✅ Model loaded successfully from cache!');
                this.logModelInfo();
                this.isLoading = false;
                return this.sessionONNX;
            }

            // Download from Hugging Face
            console.log('📥 Downloading model from Hugging Face...');
            console.log('🔗 Model URL:', this.modelPath);
            
            await this.downloadModel();
            
            // Load the downloaded model
            console.log('🤖 Creating ONNX inference session...');
            this.sessionONNX = await ort.InferenceSession.create(this.cachedModelPath, {
                executionProviders: ['cpu'],
                logSeverityLevel: 0
            });
            
            console.log('✅ Model loaded successfully from Hugging Face!');
            this.logModelInfo();
            this.isLoading = false;
            return this.sessionONNX;

        } catch (error) {
            console.error(`❌ Model loading attempt ${this.modelLoadAttempts} failed:`, error.message);
            
            // Try local fallback
            if (fs.existsSync(this.localModelPath)) {
                console.log('🔄 Attempting to load local fallback model...');
                try {
                    this.sessionONNX = await ort.InferenceSession.create(this.localModelPath, {
                        executionProviders: ['cpu'],
                        logSeverityLevel: 0
                    });
                    console.log('✅ Local fallback model loaded successfully!');
                    this.logModelInfo();
                    this.isLoading = false;
                    return this.sessionONNX;
                } catch (fallbackError) {
                    console.error('❌ Fallback model also failed:', fallbackError.message);
                }
            }
            
            this.isLoading = false;
            
            if (this.modelLoadAttempts < this.maxLoadAttempts) {
                console.log('🔄 Retrying model load in 3 seconds...');
                setTimeout(() => this.loadModel(), 3000);
            } else {
                console.error('❌ All model loading attempts failed. Running without model.');
            }
        }
    }

    async downloadModel() {
        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(this.cachedModelPath);
            let downloadedBytes = 0;
            let totalBytes = 0;

            const request = https.get(this.modelPath, (response) => {
                if (response.statusCode === 200) {
                    totalBytes = parseInt(response.headers['content-length'] || '0');
                    console.log(`📊 Model size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
                    
                    response.on('data', (chunk) => {
                        downloadedBytes += chunk.length;
                        if (totalBytes > 0) {
                            const progress = ((downloadedBytes / totalBytes) * 100).toFixed(1);
                            process.stdout.write(`\r⬇️  Downloading: ${progress}%`);
                        }
                    });
                    
                    response.pipe(file);
                    
                    file.on('finish', () => {
                        file.close();
                        console.log('\n✅ Model downloaded successfully');
                        resolve();
                    });
                    
                } else if (response.statusCode === 302 || response.statusCode === 301) {
                    // Handle redirects (common with Hugging Face URLs)
                    const redirectUrl = response.headers.location;
                    console.log('🔄 Following redirect...');
                    
                    const redirectRequest = https.get(redirectUrl, (redirectResponse) => {
                        totalBytes = parseInt(redirectResponse.headers['content-length'] || '0');
                        console.log(`📊 Model size: ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
                        
                        redirectResponse.on('data', (chunk) => {
                            downloadedBytes += chunk.length;
                            if (totalBytes > 0) {
                                const progress = ((downloadedBytes / totalBytes) * 100).toFixed(1);
                                process.stdout.write(`\r⬇️  Downloading: ${progress}%`);
                            }
                        });
                        
                        redirectResponse.pipe(file);
                        
                        file.on('finish', () => {
                            file.close();
                            console.log('\n✅ Model downloaded successfully');
                            resolve();
                        });
                    });

                    redirectRequest.on('error', (error) => {
                        fs.unlink(this.cachedModelPath, () => {});
                        reject(error);
                    });
                    
                } else {
                    reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                }
            });

            request.on('error', (error) => {
                fs.unlink(this.cachedModelPath, () => {});
                reject(error);
            });

            request.setTimeout(120000, () => { // 2 minute timeout
                request.destroy();
                reject(new Error('Download timeout (2 minutes)'));
            });
        });
    }

    async waitForLoad() {
        return new Promise((resolve) => {
            const checkLoading = () => {
                if (!this.isLoading) {
                    resolve();
                } else {
                    setTimeout(checkLoading, 100);
                }
            };
            checkLoading();
        });
    }

    logModelInfo() {
        console.log('📊 Model Info:');
        console.log('  📝 Repository: syntichemusawu/MalariaD');
        console.log('  📁 Input names:', this.sessionONNX.inputNames);
        console.log('  📤 Output names:', this.sessionONNX.outputNames);
    }

    async preprocessImage(imagePath) {
        console.log('📸 Starting image preprocessing (FIXED):', imagePath);
        
        try {
            // Get original image info first
            const originalInfo = await sharp(imagePath).metadata();
            console.log('📊 Original image info:', {
                width: originalInfo.width,
                height: originalInfo.height,
                channels: originalInfo.channels,
                format: originalInfo.format,
                space: originalInfo.space
            });

            // Load and resize image - EXACT MATCH to training preprocessing
            const buffer = await sharp(imagePath)
                .resize(224, 224) // Same as training
                .removeAlpha() // Ensure RGB only
                .raw()
                .toBuffer();

            console.log('📊 Processed image info:', {
                width: 224,
                height: 224,
                channels: 3,
                bufferSize: buffer.length
            });

            // Verify buffer size is correct (224 * 224 * 3 = 150,528)
            const expectedSize = 224 * 224 * 3;
            if (buffer.length !== expectedSize) {
                throw new Error(`Buffer size mismatch: expected ${expectedSize}, got ${buffer.length}`);
            }
    
            // Create normalized data - EXACT MATCH to training
            const float32Data = new Float32Array(3 * 224 * 224);
            
            // IMPORTANT: Use exact same normalization as training
            const mean = [0.485, 0.456, 0.406]; // ImageNet mean
            const std = [0.229, 0.224, 0.225];  // ImageNet std

            // FIXED: Process pixels in batches to avoid stack overflow
            const totalPixels = 224 * 224;
            const batchSize = 1000; // Process 1000 pixels at a time
            
            console.log(`📊 Processing ${totalPixels} pixels in batches of ${batchSize}`);
            
            for (let batch = 0; batch < Math.ceil(totalPixels / batchSize); batch++) {
                const startIdx = batch * batchSize;
                const endIdx = Math.min(startIdx + batchSize, totalPixels);
                
                for (let i = startIdx; i < endIdx; i++) {
                    // Extract RGB values (HWC format from Sharp)
                    const r_raw = buffer[i * 3 + 0]; // Red
                    const g_raw = buffer[i * 3 + 1]; // Green  
                    const b_raw = buffer[i * 3 + 2]; // Blue
                    
                    // Normalize exactly like training: (pixel/255 - mean) / std
                    const r_norm = (r_raw / 255.0 - mean[0]) / std[0];
                    const g_norm = (g_raw / 255.0 - mean[1]) / std[1];
                    const b_norm = (b_raw / 255.0 - mean[2]) / std[2];
                    
                    // Store in NCHW format: [N, C, H, W] - SAME AS ORIGINAL
                    // Channel 0 (Red): indices 0 to 224*224-1
                    // Channel 1 (Green): indices 224*224 to 2*224*224-1  
                    // Channel 2 (Blue): indices 2*224*224 to 3*224*224-1
                    float32Data[i] = r_norm;                          // Red channel
                    float32Data[i + totalPixels] = g_norm;            // Green channel
                    float32Data[i + 2 * totalPixels] = b_norm;        // Blue channel
                }
            }

            // Debug statistics (sample only to avoid stack overflow)
            const sampleSize = Math.min(1000, float32Data.length);
            const sample = Array.from(float32Data.slice(0, sampleSize));
            const minVal = Math.min(...sample);
            const maxVal = Math.max(...sample);
            const avgVal = sample.reduce((sum, val) => sum + val, 0) / sample.length;
            
            console.log('📊 Normalized pixel stats (sample):', {
                min: minVal.toFixed(4),
                max: maxVal.toFixed(4),
                average: avgVal.toFixed(4),
                sampleSize: sampleSize
            });

            // Sample first few values for debugging
            console.log('📊 First 5 R,G,B values:', 
                `R: [${Array.from(float32Data.slice(0, 5)).map(v => v.toFixed(3)).join(', ')}]`,
                `G: [${Array.from(float32Data.slice(totalPixels, totalPixels + 5)).map(v => v.toFixed(3)).join(', ')}]`,
                `B: [${Array.from(float32Data.slice(2 * totalPixels, 2 * totalPixels + 5)).map(v => v.toFixed(3)).join(', ')}]`
            );
    
            // Create tensor in NCHW format: [batch_size=1, channels=3, height=224, width=224]
            const tensor = new ort.Tensor('float32', float32Data, [1, 3, 224, 224]);
            console.log('✅ Created tensor with shape:', tensor.dims);
            
            return tensor;
            
        } catch (error) {
            console.error('❌ Image preprocessing failed:', error);
            throw new Error(`Image preprocessing failed: ${error.message}`);
        }
    }

    validateModelInput(inputTensor) {
        if (!inputTensor || !inputTensor.data || !Array.isArray(Array.from(inputTensor.data))) {
            throw new Error('Invalid input tensor format');
        }
        
        const arr = Array.from(inputTensor.data);
        const hasInvalid = arr.some(v => !Number.isFinite(v) || Number.isNaN(v));
        
        if (hasInvalid) {
            const invalidCount = arr.filter(v => !Number.isFinite(v) || Number.isNaN(v)).length;
            console.error(`❌ Found ${invalidCount} invalid values in tensor`);
            throw new Error('Input tensor contains NaN or infinite values');
        }
        
        console.log('✅ Input tensor validation passed');
        return true;
    }

    async predict(imagePath) {
        console.log('🤖 Starting FIXED prediction for image:', imagePath);
        
        try {
            // Check if model is loaded
            if (!this.sessionONNX) {
                console.error('❌ Model not loaded - using default prediction');
                return { 
                    prediction: 'Anemic', // Changed default to be more cautious
                    confidence: 0.8,
                    usingDefaultPrediction: true,
                    modelSource: 'none'
                };
            }
    
            // Preprocess image
            console.log('🔄 Step 1: Preprocessing image...');
            const inputTensor = await this.preprocessImage(imagePath);
            console.log('✅ Image preprocessing completed');
            
            // Validate input
            console.log('🔄 Step 2: Validating input tensor...');
            this.validateModelInput(inputTensor);
            
            // Run inference
            console.log('🔄 Step 3: Running model inference...');
            const inputName = this.sessionONNX.inputNames[0];
            const feeds = { [inputName]: inputTensor };
            
            console.log('📊 Inference details:', {
                inputName: inputName,
                inputShape: inputTensor.dims,
                inputType: inputTensor.type
            });
            
            const startTime = Date.now();
            const results = await this.sessionONNX.run(feeds);
            const inferenceTime = Date.now() - startTime;
            
            console.log(`✅ Model inference completed in ${inferenceTime}ms`);
            
            // Get output tensor
            const outputName = this.sessionONNX.outputNames[0];
            const outputTensor = results[outputName];
            const outputData = Array.from(outputTensor.data);
            
            console.log('📊 Raw model output:', {
                outputName: outputName,
                outputShape: outputTensor.dims,
                outputType: outputTensor.type,
                outputLength: outputData.length,
                rawOutputData: outputData
            });

            // FIXED: Output interpretation - SAME LOGIC AS ORIGINAL WORKING CODE
            console.log('🔄 Step 4: Interpreting output (FIXED)...');
            
            let prediction, confidence;
            
            // Get the confidence score (assuming single output value)
            const rawConfidence = outputData[0];
            console.log('📊 Raw confidence from model:', rawConfidence);
            
            // CRITICAL: Use SAME logic as original working server.js
            // Original code: confidence > 0.5 ? 'Non-anemic' : 'Anemic'
            if (rawConfidence > 0.5) {
                prediction = 'Non-anemic';
                confidence = rawConfidence;
            } else {
                prediction = 'Anemic';
                confidence = rawConfidence; // Keep original confidence value
            }
            
            console.log('📊 FINAL PREDICTION RESULT:', { 
                prediction, 
                confidence,
                confidencePercentage: Math.round(confidence * 100) + '%'
            });
            
            return {
                prediction,
                confidence,
                usingDefaultPrediction: false,
                modelSource: this.getModelSource(),
                debug: {
                    rawOutput: outputData,
                    outputShape: outputTensor.dims,
                    inferenceTime: inferenceTime
                }
            };
            
        } catch (error) {
            console.error('❌ Prediction error:', error);
            return {
                prediction: 'Anemic', // Cautious default
                confidence: 0.8,
                usingDefaultPrediction: true,
                modelSource: 'none',
                error: error.message
            };
        }
    }

    validateImageFile(file) {
        const errors = [];
        
        if (!file) {
            errors.push('No file provided');
            return errors;
        }

        // Check file size
        if (file.size > 10 * 1024 * 1024) { // 10MB
            errors.push('File size exceeds 10MB limit');
        }

        if (file.size < 1024) { // 1KB minimum
            errors.push('File size too small (minimum 1KB)');
        }

        // Check file type
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
        if (!allowedTypes.includes(file.mimetype)) {
            errors.push('Invalid file type. Please upload JPEG, PNG, GIF, or WebP images only.');
        }

        // Check file extension
        const allowedExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
        const fileExtension = path.extname(file.originalname).toLowerCase();
        if (!allowedExtensions.includes(fileExtension)) {
            errors.push('Invalid file extension');
        }

        return errors;
    }

    getModelSource() {
        if (fs.existsSync(this.cachedModelPath)) {
            return 'huggingface_cached';
        } else if (fs.existsSync(this.localModelPath)) {
            return 'local';
        } else {
            return 'none';
        }
    }

    getModelStatus() {
        return {
            isLoaded: !!this.sessionONNX,
            loadAttempts: this.modelLoadAttempts,
            maxAttempts: this.maxLoadAttempts,
            isLoading: this.isLoading,
            repository: 'syntichemusawu/MalariaD',
            modelUrl: this.modelPath,
            modelSource: this.getModelSource(),
            cached: fs.existsSync(this.cachedModelPath),
            localExists: fs.existsSync(this.localModelPath),
            inputNames: this.sessionONNX?.inputNames || [],
            outputNames: this.sessionONNX?.outputNames || []
        };
    }

    // Health check method
    isModelReady() {
        return this.sessionONNX !== null && !this.isLoading;
    }

    // Method to retry loading the model
    async retryLoadModel() {
        if (this.modelLoadAttempts < this.maxLoadAttempts) {
            console.log('🔄 Retrying model load...');
            await this.loadModel();
        } else {
            console.log('❌ Cannot retry - maximum attempts reached');
        }
        return this.getModelStatus();
    }

    // Clear cache method
    async clearCache() {
        try {
            if (fs.existsSync(this.cachedModelPath)) {
                fs.unlinkSync(this.cachedModelPath);
                console.log('✅ Model cache cleared');
            }
            return { success: true, message: 'Cache cleared' };
        } catch (error) {
            console.error('❌ Failed to clear cache:', error);
            return { success: false, message: error.message };
        }
    }
}

module.exports = ModelManager;