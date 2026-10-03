using System.Globalization;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Queries;

/// <summary>editor.md, A column's header: xEdit's load index, in hex. A plugin counts among the
/// active plugins of its own kind (full, medium or light). The one owner of that place and its FormID.</summary>
internal static class LoadIndex
{
    private static MasterStyle StyleOf(PluginAddress key, IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        if (!opened.TryGetValue(key, out var content)) return MasterStyle.Full;
        if (content.IsMedium) return MasterStyle.Medium;
        return content.IsLight ? MasterStyle.Small : MasterStyle.Full;
    }

    private static (string Name, MasterStyle Style, uint Place)[] Places(
        LoadOrderSnapshot snapshot, IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        var next = new Dictionary<MasterStyle, uint>();
        return [.. snapshot.Active.Select(active =>
        {
            var style = StyleOf(active.Key, opened);
            var place = next.GetValueOrDefault(style);
            next[style] = place + 1;
            return (active.Name, style, place);
        })];
    }

    internal static string Of(
        PluginAddress plugin, int loadOrderIndex, LoadOrderSnapshot snapshot,
        IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        var style = StyleOf(plugin, opened);
        var place = Places(snapshot, opened).Take(loadOrderIndex).Count(active => active.Style == style);
        return style switch
        {
            MasterStyle.Small => $"{FormID.SmallMasterMarker:X2}:{place:X3}",
            MasterStyle.Medium => $"{FormID.MediumMasterMarker:X2}:{place:X2}",
            _ => $"{place:X2}",
        };
    }

    /// <summary>xEdit's load-order FormID of a FormKey's text (TwbFormIDDefFormater.ToSortKey). Null for
    /// an unloaded plugin, and for an ID beyond its plugin's space, which Mutagen would mask onto another record.</summary>
    internal static Func<string, uint?> FormIdsOf(
        LoadOrderSnapshot snapshot, IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        // A FormKey names its plugin by filename alone; the snapshot holds one active plugin per name.
        var slots = Places(snapshot, opened).ToDictionary(p => p.Name, StringComparer.OrdinalIgnoreCase);
        uint? FormIdOf(string text)
        {
            if (!FormKey.TryFactory(text, out var key)) return null;
            if (key.IsNull) return FormID.Null.Raw;
            if (!slots.TryGetValue(key.ModKey.FileName.String, out var slot) || key.ID > FormID.IdMask(slot.Style)) return null;
            return FormID.Factory(slot.Style, slot.Place, key.ID).Raw;
        }
        return FormIdOf;
    }

    /// <summary>The FormKey a FormID names: the inverse of <see cref="FormIdsOf"/>, read from the active
    /// plugins. Null when the text is no FormID or no active plugin holds that index.</summary>
    internal static FormKey? FormKeyOf(
        string text, LoadOrderSnapshot snapshot, IReadOnlyDictionary<PluginAddress, PluginContent> opened)
    {
        var digits = text.Trim();
        if (digits.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) digits = digits[2..];
        if (digits.Length != 8 || !uint.TryParse(digits, NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out var raw))
            return null;

        var places = Places(snapshot, opened);
        var formId = new FormID(raw);
        var marker = raw >> 24;
        MasterStyle? marked = marker switch
        {
            FormID.SmallMasterMarker => MasterStyle.Small,
            FormID.MediumMasterMarker => MasterStyle.Medium,
            _ => null,
        };
        var style = marked is { } named && places.Any(p => p.Style == named) ? named : MasterStyle.Full;
        var holder = places.FirstOrDefault(p => p.Style == style && p.Place == formId.MasterIndex(style));
        return holder.Name is null ? null : new FormKey(ModKey.FromFileName(holder.Name), formId.Id(style));
    }
}
