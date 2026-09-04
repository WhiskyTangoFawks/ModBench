using System.IO.Abstractions;
using MEditService.Core.Source;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Serialization.Newtonsoft;
using Noggog.IO;

namespace MEditService.Core.Serialization;

/// <summary>The one compile-time seed the Mutagen serialization source generator needs to emit
/// &lt;Type&gt;_Serialization classes; delete it and RecordTextCodec's generated calls stop
/// resolving. Whole-mod callers go through here only (ADR-0041).</summary>
internal static class RecordTextCodecGeneratorSeed
{
    // The generator seeds from the compile-time type of argument 0 of a MutagenJsonConverter.Instance
    // call; there is no per-record seed shape, and a mod-shaped seed emits the entire schema plus a
    // public whole-mod mixin.

    // Exactly one mod-typed bootstrap call site may exist per assembly: the generated mixin file is
    // named after the seeded type, so a second collides (CS8785).

    // extraMeta is named explicitly: the generator otherwise takes positional index 5 (here
    // `cancel`) as the meta type and emits a broken CancellationToken_Serializations class. Passing
    // a non-null extraMeta anywhere emits a colliding overload (CS0111).

    /// <summary>Under FilePerRecord the root document's stream also comes from streamCreator, so a
    /// caller can capture the mod header without writing a tree. workDropoff is sequential: the
    /// parallel list helpers have a real upstream race.</summary>
    internal static Task SerializeWholeMod(
        IFallout4ModGetter mod, string folder, Noggog.WorkEngine.IWorkDropoff workDropoff, CancellationToken cancel,
        IFileSystem? fileSystem = null, ICreateStream? streamCreator = null)
        => MutagenJsonConverter.Instance.Serialize(
            mod, folder, extraMeta: null, workDropoff: workDropoff,
            fileSystem: fileSystem, streamCreator: streamCreator, cancel: cancel);

    /// <summary>Argument 0 is the folder, not a mod, so this call site emits no mixin and cannot
    /// collide (CS8785). An in-memory read needs both fileSystem and streamCreator: the reader checks
    /// File.Exists before consulting the stream creator.</summary>
    internal static async Task<IFallout4Mod> DeserializeWholeMod(
        string folder, Noggog.WorkEngine.IWorkDropoff workDropoff, CancellationToken cancel,
        IFileSystem? fileSystem = null, ICreateStream? streamCreator = null)
    {
        var mod = await MutagenJsonConverter.Instance.Deserialize(
            folder, workDropoff: workDropoff, fileSystem: fileSystem, streamCreator: streamCreator, cancel: cancel);

        // Order is parent data (ADR-0042 decision 4): directory enumeration order is undefined, so
        // each collection is restored from its parent's ordered child list at the door, so no reader
        // can obtain an unordered mod by forgetting to ask.
        SourceChildOrder.ApplyTo(folder, mod, fileSystem);
        return mod;
    }
}
