"""Descodifica QR Codes de uma imagem com o OpenCV (leitor independente do nosso gerador).
Uso: decode.py imagem.png [--cells]   -> um texto por linha.
--cells: a imagem é uma folha A4 (2x3 cartões); descodifica cada cartão em separado (mais fiável que a deteção múltipla)."""
import sys
import cv2
import numpy as np


def one(img):
    # O leitor "clássico" do OpenCV falha na deteção em cerca de 3 a 5 % de códigos perfeitamente válidos
    # (medido com 1500 endereços aleatórios: 0 falhas com cantos conhecidos e 0 falhas com o detetor Aruco).
    # Por isso tenta-se também o detetor Aruco, e só se dá como ilegível se todos falharem.
    readers = [cv2.QRCodeDetector(), cv2.QRCodeDetectorAruco()]
    pad = cv2.copyMakeBorder(img, 40, 40, 40, 40, cv2.BORDER_CONSTANT, value=(255, 255, 255))
    big = cv2.resize(pad, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST)
    for candidate in (img, big):
        for det in readers:
            text, _, _ = det.detectAndDecode(candidate)
            if text:
                return text
    return ''


def main():
    path = sys.argv[1]
    cells = '--cells' in sys.argv
    img = cv2.imread(path)
    if img is None:
        print('ERRO: não consegui abrir', path, file=sys.stderr)
        sys.exit(2)
    out = []
    if cells:
        h, w = img.shape[:2]
        # A4 = 210x297 mm; margens 10 mm; 2 colunas x 3 linhas; intervalo 4 mm
        mm = w / 210.0
        cw, ch = (190 - 4) / 2, (276 - 8) / 3
        for r in range(3):
            for c in range(2):
                x0 = int((10 + c * (cw + 4)) * mm)
                y0 = int((10 + r * (ch + 4)) * mm)
                crop = img[y0:y0 + int(ch * mm), x0:x0 + int(cw * mm)]
                if crop.size == 0:
                    continue
                t = one(crop)
                out.append(t or '')
    else:
        t = one(img)
        out.append(t or '')
    for t in out:
        print(t)


main()
