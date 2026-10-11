using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Headers;
using Mutagen.Bethesda.Plugins.Meta;

namespace MEditService.PluginAdapter;

/// <summary>A plugin file's own bytes for a record: what subrecords it holds, which the overlay does not
/// say. Located on first use, as only a record the overlay cannot serialize asks.</summary>
internal sealed class PluginRecordBytes(ModPath path, GameRelease release)
{
    private static readonly RecordType EditorId = new("EDID");

    private readonly Lazy<ILookup<FormKey, (int Start, int Length)>> _locations = new(() =>
    {
        var masters = PluginBinaryWalk.MastersOf(path, release);
        return PluginBinaryWalk.Records(File.ReadAllBytes(path.Path), release).ToLookup(
            record => PluginBinaryWalk.FormKeyOf(record, masters, path.ModKey), record => (record.Location, (int)record.TotalLength));
    });

    /// <summary>Whether the record holds no subrecord but its EditorID, which its header carries.</summary>
    public bool HoldsNoFields(FormKey formKey)
    {
        if (_locations.Value[formKey].FirstOrDefault() is not { Length: > 0 } location) return false;
        var bytes = new byte[location.Length];
        using (var file = File.OpenHandle(path.Path)) RandomAccess.Read(file, bytes, location.Start);
        return PluginBinaryWalk.Subrecords(GameConstants.Get(release).MajorRecord(bytes)) is { } subrecords
            && subrecords.All(subrecord => subrecord.RecordType == EditorId);
    }
}
