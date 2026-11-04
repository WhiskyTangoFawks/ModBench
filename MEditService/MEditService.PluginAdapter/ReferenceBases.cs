using System.Buffers.Binary;
using System.Collections;
using System.Collections.Concurrent;
using System.Reflection;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Plugins.Utility;
using Noggog;

namespace MEditService.PluginAdapter;

/// <summary>The member Mutagen reads a reference's NAME into, which differs by reference type.</summary>
internal static class ReferenceBases
{
    private const uint FirstProbeId = 0x1000;

    private static readonly ConcurrentDictionary<(GameCategory Game, Type Record), string?> Members = new();

    // Found by writing the record once with each of its links set to an ID of its own: Mutagen's writer
    // is the only place that says which member a subrecord holds.
    internal static string? NameMemberOf(Type recordType, GameRelease release) =>
        Members.GetOrAdd((release.ToCategory(), recordType), _ => Probed(recordType, release));

    private static string? Probed(Type recordType, GameRelease release)
    {
        var modKey = ModKey.FromFileName("Probe.esp");
        var links = recordType.GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(property => property.GetIndexParameters().Length == 0 && typeof(IFormLinkGetter).IsAssignableFrom(property.PropertyType))
            .ToList();
        var mod = ModFactory.Activator(modKey, release);
        var record = MajorRecordInstantiator.Activator(mod.GetNextFormKey(), release, recordType);
        for (var i = 0; i < links.Count; i++)
        {
            var link = links[i].GetValue(record);
            link?.GetType().GetMethod("SetTo", [typeof(FormKey?)])?.Invoke(link, [new FormKey(modKey, FirstProbeId + (uint)i)]);
        }
        PlacedInInteriorCell(mod, record, release);

        using var stream = new MemoryStream();
        mod.WriteToBinary(stream);
        var written = stream.ToArray();
        var named = links.Where((_, i) => HoldsName(written, FirstProbeId + (uint)i)).ToList();
        return named.Count == 1 ? named[0].Name : null;
    }

    private static void PlacedInInteriorCell(IMod mod, IMajorRecord record, GameRelease release)
    {
        var types = RecordTypes.For(release);
        var cells = mod.GetType().GetProperty(types.GroupOf(types.Cell) ?? "", BindingFlags.Public | BindingFlags.Instance)
            ?? throw new InvalidOperationException("Expected a mod to hold its cells.");
        var group = cells.GetValue(mod) ?? throw new InvalidOperationException("Expected a mod to hold its cells.");
        var blocks = (IList)(group.GetType().GetProperty("Records")?.GetValue(group) ?? throw new InvalidOperationException("Expected a cell group to hold blocks."));

        var block = NewLevel(blocks, RecordTypes.InteriorCellBlockGroupTypes[0]);
        var subBlock = NewLevel((IList)ItemsOf(block, RecordTypes.BlockChildMember), RecordTypes.InteriorCellBlockGroupTypes[1]);
        var cellsOfSubBlock = (IList)ItemsOf(subBlock, RecordTypes.SubBlockChildMember);
        var cell = MajorRecordInstantiator.Activator(mod.GetNextFormKey(), release, ElementTypeOf(cellsOfSubBlock));
        cellsOfSubBlock.Add(cell);
        ((IList)ItemsOf(cell, "Persistent")).Add(record);
    }

    private static object NewLevel(IList list, string groupType)
    {
        var level = Activator.CreateInstance(ElementTypeOf(list)) ?? throw new InvalidOperationException("Expected a block level to instantiate.");
        var groupTypeProperty = level.GetType().GetProperty(RecordTypes.GroupTypeMember) ?? throw new InvalidOperationException("Expected a block level to name its group type.");
        groupTypeProperty.SetValue(level, Enum.Parse(groupTypeProperty.PropertyType, groupType));
        list.Add(level);
        return level;
    }

    private static object ItemsOf(object owner, string member) =>
        owner.GetType().GetProperty(member)?.GetValue(owner) ?? throw new InvalidOperationException($"Expected '{owner.GetType().Name}' to hold '{member}'.");

    private static Type ElementTypeOf(IList list) =>
        list.GetType().GetInterfaces().Single(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IList<>)).GetGenericArguments()[0];

    private static bool HoldsName(byte[] written, uint id)
    {
        Span<byte> subrecord = stackalloc byte[10];
        "NAME"u8.CopyTo(subrecord);
        BinaryPrimitives.WriteUInt16LittleEndian(subrecord[4..], sizeof(uint));
        BinaryPrimitives.WriteUInt32LittleEndian(subrecord[6..], id);
        return written.AsSpan().IndexOf(subrecord) >= 0;
    }
}
