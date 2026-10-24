import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cairo from 'cairo';

// Donut gauge for the panel, drawn with Cairo.
export const Ring = GObject.registerClass(
class KgRing extends St.DrawingArea {
    _init() {
        super._init({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._pct = null;
        this._fill = [0.1, 0.7, 1, 1];
        this._track = [0.5, 0.5, 0.5, 0.3];
        this._stroke = 3;
        this._dot = null;
    }

    applyStyle({size, stroke, track}) {
        this.set_size(size, size);
        this._stroke = stroke;
        this._track = track;
        this.queue_repaint();
    }

    // dot: optional account colour drawn as a centre dot (per-account rings).
    setValue(pct, fill, dot = null) {
        this._pct = pct === null ? null : Math.max(0, Math.min(100, pct));
        this._fill = fill;
        this._dot = dot;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2;
        const cy = h / 2;
        const radius = Math.max(0, Math.min(w, h) / 2 - this._stroke / 2);
        cr.setLineWidth(this._stroke);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setSourceRGBA(...this._track);
        cr.arc(cx, cy, radius, 0, 2 * Math.PI);
        cr.stroke();
        if (this._pct !== null && this._pct > 0) {
            cr.setSourceRGBA(...this._fill);
            const start = -Math.PI / 2;
            cr.arc(cx, cy, radius, start, start + (this._pct / 100) * 2 * Math.PI);
            cr.stroke();
        }
        if (this._dot) {
            cr.setSourceRGBA(...this._dot);
            cr.arc(cx, cy, Math.max(1.5, radius * 0.28), 0, 2 * Math.PI);
            cr.fill();
        }
        cr.$dispose();
    }
});

// Horizontal quota bar for menu rows.
export const Bar = GObject.registerClass(
class KgBar extends St.DrawingArea {
    _init(height = 6) {
        super._init({x_expand: true, y_align: Clutter.ActorAlign.CENTER, height});
        this._pct = 0;
        this._fill = [0.1, 0.7, 1, 1];
        this._track = [0.5, 0.5, 0.5, 0.3];
        this._h = height;
    }

    setValue(pct, fill, track) {
        this._pct = Math.max(0, Math.min(100, pct));
        this._fill = fill;
        this._track = track;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const r = h / 2;
        const rounded = (x, width) => {
            cr.newSubPath();
            cr.arc(x + width - r, r, r, -Math.PI / 2, Math.PI / 2);
            cr.arc(x + r, r, r, Math.PI / 2, 3 * Math.PI / 2);
            cr.closePath();
        };
        cr.setSourceRGBA(...this._track);
        rounded(0, w);
        cr.fill();
        const fw = Math.max(this._pct > 0 ? h : 0, (w * this._pct) / 100);
        if (fw > 0) {
            cr.setSourceRGBA(...this._fill);
            rounded(0, Math.min(w, fw));
            cr.fill();
        }
        cr.$dispose();
    }
});
