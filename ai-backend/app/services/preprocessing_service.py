import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter


class PreprocessingService:
    def deskew(self, image: Image.Image) -> Image.Image:
        try:
            img_np = np.array(image.convert("L"))
            coords = np.column_stack(np.where(img_np > 0))
            if len(coords) < 10:
                return image
            angle = cv2.minAreaRect(coords)[-1]
            if angle < -45:
                angle = 90 + angle
            angle = -angle
            if abs(angle) < 0.5:
                return image
            h, w = img_np.shape[:2]
            center = (w // 2, h // 2)
            M = cv2.getRotationMatrix2D(center, angle, 1.0)
            rotated = cv2.warpAffine(img_np, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
            return Image.fromarray(rotated)
        except Exception:
            return image

    def denoise(self, image: Image.Image) -> Image.Image:
        try:
            img_np = np.array(image)
            denoised = cv2.fastNlMeansDenoisingColored(img_np, None, 10, 10, 7, 21)
            return Image.fromarray(denoised)
        except Exception:
            return image

    def enhance_contrast(self, image: Image.Image) -> Image.Image:
        try:
            img_np = np.array(image.convert("L"))
            clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
            enhanced = clahe.apply(img_np)
            if image.mode == "RGB":
                return Image.fromarray(cv2.cvtColor(enhanced, cv2.COLOR_GRAY2RGB))
            return Image.fromarray(enhanced)
        except Exception:
            enhancer = ImageEnhance.Contrast(image)
            return enhancer.enhance(1.5)

    def binarize(self, image: Image.Image) -> Image.Image:
        try:
            img_np = np.array(image.convert("L"))
            _, binary = cv2.threshold(img_np, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
            if image.mode == "RGB":
                return Image.fromarray(cv2.cvtColor(binary, cv2.COLOR_GRAY2RGB))
            return Image.fromarray(binary)
        except Exception:
            return image

    def normalize_dpi(self, image: Image.Image, target_dpi: int = 300) -> Image.Image:
        try:
            dpi = image.info.get("dpi", (72, 72))
            current_dpi = dpi[0] if isinstance(dpi, (tuple, list)) else 72
            if current_dpi < target_dpi:
                scale = target_dpi / current_dpi
                new_size = (int(image.width * scale), int(image.height * scale))
                return image.resize(new_size, Image.LANCZOS)
            return image
        except Exception:
            return image

    def preprocess(self, image_path: str) -> str:
        img = Image.open(image_path)
        img = self.normalize_dpi(img)
        img = self.deskew(img)
        img = self.denoise(img)
        img = self.enhance_contrast(img)
        img = self.binarize(img)
        img.save(image_path, quality=95)
        return image_path

    def preprocess_all(self, image_paths: list[str]) -> list[str]:
        for path in image_paths:
            self.preprocess(path)
        return image_paths


preprocessing_service = PreprocessingService()
