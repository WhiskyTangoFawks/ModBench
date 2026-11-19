using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Newtonsoft;
using Noggog.WorkEngine;

namespace MEditService.Codec.Proof;

/// <summary>The game's serializer with no customization, for ADR-0006's proof. A compilation of its own,
/// since the generator reads every customization a compilation holds.</summary>
public static class ProofSerializer
{
    // extraMeta is named: the generator otherwise takes a positional argument as the meta type.
    public static Task Serialize(IModGetter plugin, Stream text) =>
        MutagenJsonConverter.Instance.Serialize((IGameModGetter)plugin, text, extraMeta: null, workDropoff: InlineWorkDropoff.Instance);

    // Mutagen numbers each game's release as the GameRelease it names.
    public static async Task<IMod> Deserialize(Stream text, ModKey modKey, GameRelease release) =>
        await MutagenJsonConverter.Instance.Deserialize(text, modKey, (GameModRelease)(int)release, workDropoff: InlineWorkDropoff.Instance);
}
