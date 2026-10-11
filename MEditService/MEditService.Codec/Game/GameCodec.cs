using System.IO.Abstractions;
using System.Reflection;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Newtonsoft;
using Noggog;
using Noggog.IO;
using Noggog.WorkEngine;

namespace MEditService.Codec.Game;

/// <summary>The one compile-time seed the Mutagen serialization source generator needs to emit
/// &lt;Type&gt;_Serialization classes for the game this project compiles against.</summary>
internal sealed class GameCodec : IGameCodec
{
    // The generator seeds from the compile-time type of argument 0 of a MutagenJsonConverter.Instance
    // call; there is no per-record seed shape, and a mod-shaped seed emits the entire schema plus a
    // public whole-mod mixin.

    // Exactly one mod-typed bootstrap call site may exist per assembly: the generated mixin file is
    // named after the seeded type, so a second collides (CS8785).

    // extraMeta is named explicitly: the generator otherwise takes positional index 5 (here
    // `cancel`) as the meta type and emits a broken CancellationToken_Serializations class. Passing
    // a non-null extraMeta anywhere emits a colliding overload (CS0111).

    public Assembly GeneratedSerializers => typeof(GameCodec).Assembly;

    public SiblingsInUseRows SiblingsInUse =>
        GameSpecifics.SiblingsInUse;

    public CreationKitShapes CreationKitShapes => GameSpecifics.CreationKitShapes;

    public IReadOnlyList<string> TransientTypes(IModGetter plugin) => GameSpecifics.TransientTypes((IGameModGetter)plugin);

    public uint NextObjectIdDefault => ModStats.NextFormIDDefault;

    public Task SerializeWholeMod(
        IModGetter plugin, string folder, IWorkDropoff workDropoff, CancellationToken cancel,
        IFileSystem? fileSystem = null, ICreateStream? streamCreator = null)
        => MutagenJsonConverter.Instance.Serialize(
            (IGameModGetter)plugin, folder, extraMeta: null, workDropoff: workDropoff,
            fileSystem: fileSystem, streamCreator: streamCreator, cancel: cancel);

    // Argument 0 is the folder, not a mod, so this call site emits no mixin and cannot collide (CS8785).
    public async Task<IMod> DeserializeWholeMod(
        string folder, IWorkDropoff workDropoff, CancellationToken cancel,
        IFileSystem? fileSystem = null, ICreateStream? streamCreator = null)
        => AbsentIndexes.Fill<IMod>(await MutagenJsonConverter.Instance.Deserialize(
            folder, workDropoff: workDropoff, fileSystem: fileSystem, streamCreator: streamCreator, cancel: cancel));

    // Serialized from a header-only clone: a full-mod walk costs ~1.5 s per plugin, the clone 1 ms,
    // byte-identical.
    public IModGetter HeaderOnly(IModGetter plugin)
    {
        var source = (IGameModGetter)plugin;
        var clone = ModFactory<GameMod>.Activator(source.ModKey, source.GameRelease);
        clone.ModHeader.DeepCopyIn(source.ModHeader);
        return clone;
    }

    public IMajorRecordGetter NormalizeEncoding(IMajorRecordGetter record)
    {
        if (record is not (ICellGetter or IWorldspaceGetter or IDialogTopicGetter) && !GameSpecifics.Normalizes(record)) return record;
        var copy = record.DeepCopy();
        switch (copy)
        {
            case Cell cell:
                ZeroCellGroupFields(cell);
                break;
            case Worldspace worldspace:
                worldspace.SubCellsTimestamp = 0;
                worldspace.SubCellsUnknown = 0;
                foreach (var block in worldspace.SubCells)
                {
                    block.LastModified = 0;
                    block.Unknown = 0;
                    foreach (var subBlock in block.Items)
                    {
                        subBlock.LastModified = 0;
                        subBlock.Unknown = 0;
                        foreach (var nestedCell in subBlock.Items) ZeroCellGroupFields(nestedCell);
                        subBlock.Items.SetTo(subBlock.Items.OrderBy(c => c.FormKey.ToString(), StringComparer.Ordinal).ToList());
                    }
                    block.Items.SetTo(block.Items.OrderBy(s => s.BlockNumberX).ThenBy(s => s.BlockNumberY).ToList());
                }
                worldspace.SubCells.SetTo(worldspace.SubCells.OrderBy(b => b.BlockNumberX).ThenBy(b => b.BlockNumberY).ToList());
                if (worldspace.TopCell is { } topCell) ZeroCellGroupFields(topCell);
                break;
            case DialogTopic topic:
                ZeroTopicGroupFields(topic);
                break;
        }
        GameSpecifics.Normalize(copy);
        return copy;
    }

    internal static void ZeroTopicGroupFields(DialogTopic topic)
    {
        topic.Timestamp = 0;
        topic.Unknown = 0;
    }

    private static void ZeroCellGroupFields(Cell cell)
    {
        cell.Timestamp = 0;
        cell.UnknownGroupData = 0;
        cell.PersistentTimestamp = 0;
        cell.PersistentUnknownGroupData = 0;
        cell.TemporaryTimestamp = 0;
        cell.TemporaryUnknownGroupData = 0;
    }
}
