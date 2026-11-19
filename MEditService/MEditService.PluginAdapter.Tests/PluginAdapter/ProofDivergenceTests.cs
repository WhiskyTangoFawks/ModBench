using System.IO.Abstractions;
using System.Reflection;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Exceptions;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.IO;
using Noggog.WorkEngine;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class ProofDivergenceTests
{
    [Fact]
    public void AValueTheProofTextLoses_IsNamedAsLostInMutagensSerialization_EvenWhenTheRecompiledPluginMatches()
    {
        var divergence = DivergenceOfAPluginFromItself(game => new ProofLosingEditorIds(game)).Answered();

        Assert.Equal(
            "Keyword 000800:Fixture.esp (EditorID 'Kept') differs after a round trip through Mutagen's JSON serialization "
            + "with no customization — field 'EditorID' changed.",
            divergence?.Description);
    }

    [Fact]
    public void AProofTextThatCannotBeWritten_IsTheVerdictsFailure_NotAWaitForTextThatNeverComes()
    {
        var answer = DivergenceOfAPluginFromItself(game => new ProofTextUnwritable(game));

        Assert.Contains(ProofTextUnwritable.Reason, answer.Failure().Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void AMasterTheProofsReadCannotFind_IsNamedAsAMasterTheLoadOrderLacks_NotAsAnUnparsedPlugin()
    {
        var answer = DivergenceOfAPluginFromItself(game => new ProofReadMissingMaster(game));

        Assert.IsType<PluginFailure.MasterNotInLoadOrder>(answer.Failure());
    }

    [Fact]
    public async Task AProofReadThatFails_StopsTheWriterOfItsText()
    {
        var codec = default(ProofReadFailingBeforeTheTextEnds);

        _ = DivergenceOfAPluginFromItself(game => codec = new ProofReadFailingBeforeTheTextEnds(game));

        await codec.Require().WriterStopped.WaitAsync(TimeSpan.FromSeconds(10));
    }

    [Fact]
    public void AQuestsTopicsTheProofTextReordered_AreNamedAsLostInMutagensSerialization_ThoughTheSourcesFormatKeepsNoOrderForThem()
    {
        var divergence = DivergenceOfAPluginFromItself(game => new ProofReversingTopics(game), plugin =>
        {
            var quest = plugin.Quests.AddNew("Asked");
            quest.DialogTopics.Add(new DialogTopic(plugin) { EditorID = "First" });
            quest.DialogTopics.Add(new DialogTopic(plugin) { EditorID = "Second" });
        }).Answered();

        Assert.StartsWith("Quest 000800:Fixture.esp (EditorID 'Asked') differs after a round trip through Mutagen's JSON serialization", divergence?.Description);
    }

    [Fact]
    public void AListTheProofTextPutInTheFormatsOrder_IsNamedAsLostInMutagensSerialization()
    {
        var divergence = DivergenceOfAPluginFromItself(game => new ProofInTheFormatsOrder(game), plugin =>
        {
            var npc = plugin.Npcs.AddNew("Ranked");
            npc.Factions.AddRange(new[] { 0x802u, 0x801u }.Select(id => new RankPlacement { Faction = new FormLink<IFactionGetter>(new FormKey(plugin.ModKey, id)) }));
        }).Answered();

        Assert.StartsWith("Npc 000800:Fixture.esp (EditorID 'Ranked') differs after a round trip through Mutagen's JSON serialization", divergence?.Description);
    }

    [Fact]
    public void BothTripsFailing_AnswersTheFailureThatNamesItsCause_OverOneThatOnlyFailedToParse()
    {
        var answer = DivergenceOfAPluginFromItself(game => new ProofReadFailingBeforeTheTextEnds(game), recompiled: "Absent.esp");

        Assert.IsType<PluginFailure.Inaccessible>(answer.Failure());
    }

    private static Answer<PluginDivergence?, PluginFailure> DivergenceOfAPluginFromItself(
        Func<IGameCodec, IGameCodec> fallout4, Action<Fallout4Mod>? build = null, string recompiled = "Fixture.esp")
    {
        using var scratch = new ScratchDirectory("medit-proof-divergence-");
        var plugin = new Fallout4Mod(ModKey.FromFileName("Fixture.esp"), Fallout4Release.Fallout4);
        (build ?? (mod => mod.Keywords.AddNew("Kept")))(plugin);
        var path = Path.Combine(scratch, "Fixture.esp");
        ((IModGetter)plugin).WriteToBinary(path);

        var registered = new Dictionary<GameCategory, IGameCodec>
        {
            [GameCategory.Fallout4] = GameCodecs.For(GameRelease.Fallout4),
            [GameCategory.Skyrim] = GameCodecs.For(GameRelease.SkyrimSE),
            [GameCategory.Starfield] = GameCodecs.For(GameRelease.Starfield),
        };
        GameCodecs.Register(new Dictionary<GameCategory, IGameCodec>(registered)
        {
            [GameCategory.Fallout4] = fallout4(registered[GameCategory.Fallout4]),
        });
        try
        {
            return TestAdapters.Mutagen().DivergenceFrom(
                "Fixture.esp", path, Path.Combine(scratch, recompiled), EmptyLoadOrder.Of(GameRelease.Fallout4), PluginStrings.None);
        }
        finally
        {
            GameCodecs.Register(registered);
        }
    }

    private sealed class ProofLosingEditorIds(IGameCodec game) : DelegatingGameCodec(game)
    {
        public override async Task<IMod> ReadProofText(Stream text, ModKey modKey, GameRelease release)
        {
            var read = await base.ReadProofText(text, modKey, release);
            read.EnumerateMajorRecords().Single().EditorID = null;
            return read;
        }
    }

    private sealed class ProofReversingTopics(IGameCodec game) : DelegatingGameCodec(game)
    {
        public override async Task<IMod> ReadProofText(Stream text, ModKey modKey, GameRelease release)
        {
            var read = await base.ReadProofText(text, modKey, release);
            foreach (var quest in ((IFallout4Mod)read).Quests) quest.DialogTopics.Reverse();
            return read;
        }
    }

    private sealed class ProofInTheFormatsOrder(IGameCodec game) : DelegatingGameCodec(game)
    {
        public override async Task<IMod> ReadProofText(Stream text, ModKey modKey, GameRelease release)
        {
            var read = await base.ReadProofText(text, modKey, release);
            foreach (var npc in ((IFallout4Mod)read).Npcs)
            {
                var ordered = npc.Factions.OrderBy(faction => faction.Faction.FormKey).ToList();
                npc.Factions.Clear();
                npc.Factions.AddRange(ordered);
            }
            return read;
        }
    }

    private sealed class ProofTextUnwritable(IGameCodec game) : DelegatingGameCodec(game)
    {
        public const string Reason = "The proof text could not be written.";

        public override Task WriteProofText(IModGetter plugin, Stream text) => throw new IOException(Reason);
    }

    private sealed class ProofReadMissingMaster(IGameCodec game) : DelegatingGameCodec(game)
    {
        public override Task<IMod> ReadProofText(Stream text, ModKey modKey, GameRelease release) =>
            throw new MissingModException(ModKey.FromFileName("Absent.esm"));
    }

    private sealed class ProofReadFailingBeforeTheTextEnds(IGameCodec game) : DelegatingGameCodec(game)
    {
        public Task WriterStopped => _writerStopped.Task;

        private readonly TaskCompletionSource _writerStopped = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public override async Task WriteProofText(IModGetter plugin, Stream text)
        {
            try
            {
                while (true) await text.WriteAsync(new byte[4096]);
            }
            finally
            {
                _writerStopped.SetResult();
            }
        }

        public override Task<IMod> ReadProofText(Stream text, ModKey modKey, GameRelease release) =>
            throw new InvalidDataException("The proof text could not be read.");
    }

    private abstract class DelegatingGameCodec(IGameCodec game) : IGameCodec
    {
        public virtual Task WriteProofText(IModGetter plugin, Stream text) => game.WriteProofText(plugin, text);

        public virtual Task<IMod> ReadProofText(Stream text, ModKey modKey, GameRelease release) => game.ReadProofText(text, modKey, release);

        public Assembly GeneratedSerializers => game.GeneratedSerializers;

        public Task SerializeWholeMod(
            IModGetter plugin, string folder, IWorkDropoff workDropoff, CancellationToken cancel,
            IFileSystem? fileSystem = null, ICreateStream? streamCreator = null) =>
            game.SerializeWholeMod(plugin, folder, workDropoff, cancel, fileSystem, streamCreator);

        public Task<IMod> DeserializeWholeMod(
            string folder, IWorkDropoff workDropoff, CancellationToken cancel,
            IFileSystem? fileSystem = null, ICreateStream? streamCreator = null) =>
            game.DeserializeWholeMod(folder, workDropoff, cancel, fileSystem, streamCreator);

        public string SpriggitPackage => game.SpriggitPackage;

        public string SpriggitVersion => game.SpriggitVersion;

        public int BlueprintFlag => game.BlueprintFlag;

        public IReadOnlyDictionary<string, int> LoadFlags => game.LoadFlags;

        public IReadOnlyList<IReadOnlyList<HeaderFlag>> NewPluginFlags(GameRelease release, ModType type) => game.NewPluginFlags(release, type);

        public SchemaAnnotations Annotations => game.Annotations;

        public CreationKitShapes CreationKitShapes => game.CreationKitShapes;

        public IReadOnlyList<string> TransientTypes(IModGetter plugin) => game.TransientTypes(plugin);

        public IMajorRecordGetter NormalizeEncoding(IMajorRecordGetter record, bool localized, Func<Type, string?> baseMemberOf) =>
            game.NormalizeEncoding(record, localized, baseMemberOf);

        public IMajorRecordGetter NormalizeFormat(IMajorRecordGetter record) => game.NormalizeFormat(record);

        public IModGetter HeaderOnly(IModGetter plugin) => game.HeaderOnly(plugin);
    }
}
