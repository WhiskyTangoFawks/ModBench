using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Analysis;
using Mutagen.Bethesda.Plugins.Binary.Headers;
using Mutagen.Bethesda.Plugins.Meta;

namespace MEditService.PluginAdapter;

/// <summary>A plugin file's own bytes for a record: what subrecords it holds, which the overlay does not
/// say. Located on first use, as only a record the overlay cannot serialize asks.</summary>
public sealed class PluginRecordBytes(ModPath path, GameRelease release) : IRecordFieldProbe
{
    private static readonly RecordType EditorId = new("EDID");

    private readonly Lazy<RecordLocatorResults> _locations = new(() => RecordLocator.GetLocations(path, release, loadOrder: null));

    /// <summary>Whether the record holds no subrecord but its EditorID, which its header carries.</summary>
    public bool HoldsNoFields(FormKey formKey)
    {
        if (!_locations.Value.TryGetSection(formKey, out var section)) return false;
        var bytes = new byte[section.Max - section.Min + 1];
        using (var file = File.OpenRead(path.Path))
        {
            file.Position = section.Min;
            file.ReadExactly(bytes);
        }
        var frame = new MajorRecordFrame(GameConstants.Get(release), bytes);
        if (frame.IsCompressed) frame = frame.Decompress(out _);
        return frame.EnumerateSubrecords().All(subrecord => subrecord.RecordType == EditorId);
    }
}
