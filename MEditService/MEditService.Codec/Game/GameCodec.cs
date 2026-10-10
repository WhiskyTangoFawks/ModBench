using System.IO.Abstractions;
using System.Reflection;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Newtonsoft;
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
        => await MutagenJsonConverter.Instance.Deserialize(
            folder, workDropoff: workDropoff, fileSystem: fileSystem, streamCreator: streamCreator, cancel: cancel);

    // Serialized from a header-only clone: a full-mod walk costs ~1.5 s per plugin, the clone 1 ms,
    // byte-identical.
    public IModGetter HeaderOnly(IModGetter plugin)
    {
        var source = (IGameModGetter)plugin;
        var clone = ModFactory<GameMod>.Activator(source.ModKey, source.GameRelease);
        clone.ModHeader.DeepCopyIn(source.ModHeader);
        return clone;
    }
}
