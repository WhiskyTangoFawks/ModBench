using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>A child a later plugin adds to a container an earlier plugin owns. The Index merges the
/// two plugins' children; neither document holds the other's. A container type is a row in
/// <see cref="Injections"/>.</summary>
public sealed class InjectedChildTests
{
    public static TheoryData<string> Injections =>
        [TopicUnderQuest, BranchUnderQuest, SceneUnderQuest, ResponseUnderTopic];

    private const string TopicUnderQuest = "a topic under a quest";
    private const string BranchUnderQuest = "a dialog branch under a quest";
    private const string SceneUnderQuest = "a scene under a quest";
    private const string ResponseUnderTopic = "a response under a dialog topic";

    // ---- cold ingest ----

    [Theory]
    [MemberData(nameof(Injections))]
    public void AfterAColdIngest_TheInjectedChildIsListedUnderItsContainer_AsTheWinner(string injection)
    {
        using var fixture = new TwoPlugins();
        var (container, child, recordType) = fixture.Case(injection);

        var listed = Assert.Single(
            fixture.Children(fixture.Injector, container), c => c.FormKey == child.ToString());

        Assert.True(listed.IsWinner, $"'{injection}' is the only copy of its FormKey, so it wins.");
        Assert.Equal(TwoPlugins.InjectorPluginName, listed.Plugin);
        Assert.Equal(recordType, listed.RecordType);
    }

    [Theory]
    [MemberData(nameof(Injections))]
    public void AfterAColdIngest_TheOwningPluginsOwnListing_DoesNotHoldTheInjectedChild(string injection)
    {
        using var fixture = new TwoPlugins();
        var (container, child, _) = fixture.Case(injection);

        // A container override holds only its own plugin's children, as its GRUP does: the union is
        // the Index's to derive, never a document's to store.
        Assert.DoesNotContain(
            child.ToString(),
            fixture.Children(fixture.Base, container).Select(c => c.FormKey));
    }

    // Both polarities of the winner in one place: the same child FormKey is listed under the same
    // container from both plugins, and only the later plugin's copy wins.
    [Fact]
    public void AfterAColdIngest_TheInjectorsOverrideOfABaseChild_WinsOverTheBasePluginsOwnCopy()
    {
        using var fixture = new TwoPlugins();

        var fromInjector = Assert.Single(
            fixture.Children(fixture.Injector, fixture.Quest), c => c.FormKey == fixture.BaseTopic.ToString());
        var fromBase = Assert.Single(
            fixture.Children(fixture.Base, fixture.Quest), c => c.FormKey == fixture.BaseTopic.ToString());

        Assert.True(fromInjector.IsWinner);
        Assert.False(fromBase.IsWinner);
    }

    // ---- after an edit to the injecting plugin ----

    [Theory]
    [MemberData(nameof(Injections))]
    public void AfterAnEditToTheInjectingPlugin_TheInjectedChildIsStillListedUnderItsContainer(string injection)
    {
        using var fixture = new TwoPlugins();
        var (container, child, _) = fixture.Case(injection);
        fixture.TrackBoth();
        var service = ProjectingEditService.Over(fixture.Mirror);

        var edit = service.Set(
            fixture.Injector, child.ToString(), "EditorID", JsonDocument.Parse("\"Renamed\"").RootElement);

        Assert.True(edit.Applied, edit.Message);
        var listed = Assert.Single(
            fixture.Children(fixture.Injector, container), c => c.FormKey == child.ToString());
        Assert.Equal("Renamed", listed.EditorId);
        Assert.True(listed.IsWinner);
    }

    // ---- after Track and compile of both plugins ----

    [Theory]
    [MemberData(nameof(Injections))]
    public void AfterTrackAndCompileOfBothPlugins_TheInjectingPluginsBinaryHoldsTheChildUnderItsContainer(string injection)
    {
        using var fixture = new TwoPlugins();
        var (container, child, _) = fixture.Case(injection);
        fixture.TrackBoth();

        using var compiled = fixture.CompileAndReimport(fixture.Injector);

        Assert.Contains(child, ChildrenOf(compiled, container));
    }

    [Theory]
    [MemberData(nameof(Injections))]
    public void AfterTrackAndCompileOfBothPlugins_TheOwningPluginsBinaryKeepsItsOwnChildrenAndNotTheInjected(string injection)
    {
        using var fixture = new TwoPlugins();
        var (container, child, _) = fixture.Case(injection);
        fixture.TrackBoth();

        using var compiled = fixture.CompileAndReimport(fixture.Base);

        var own = ChildrenOf(compiled, container);
        Assert.DoesNotContain(child, own);
        Assert.NotEmpty(own);
    }

    // Mutagen's own descent, so a case is a container FormKey and a child FormKey and nothing else.
    private static IEnumerable<FormKey> ChildrenOf(IModGetter mod, FormKey container) =>
        mod.EnumerateMajorRecords().Single(r => r.FormKey == container)
            .EnumerateMajorRecords().Select(r => r.FormKey);

    // A base plugin owning a quest, a topic, a response, a branch and a scene; a later plugin
    // whose overrides of the quest and the topic hold only the children it adds itself.
    private sealed class TwoPlugins : IDisposable
    {
        public const string BasePluginName = "InjectionBase.esm";
        public const string BaseOrigin = "InjectionBaseMod";
        public const string InjectorPluginName = "InjectionInjector.esp";
        public const string InjectorOrigin = "InjectionInjectorMod";

        private readonly string _baseModFolder;
        private readonly string _injectorModFolder;
        private readonly string _gameDirectory;

        public LoadOrderMirror Mirror { get; }
        public PluginKey Base { get; } = new(BasePluginName, BaseOrigin);
        public PluginKey Injector { get; } = new(InjectorPluginName, InjectorOrigin);

        public FormKey Quest { get; }
        public FormKey BaseTopic { get; }
        public FormKey InjectedTopic { get; }
        public FormKey InjectedBranch { get; }
        public FormKey InjectedScene { get; }
        public FormKey InjectedResponse { get; }

        public TwoPlugins()
        {
            _baseModFolder = Directory.CreateTempSubdirectory("medit-injection-base-").FullName;
            _injectorModFolder = Directory.CreateTempSubdirectory("medit-injection-injector-").FullName;
            _gameDirectory = Directory.CreateTempSubdirectory("medit-injection-game-").FullName;

            var basePath = Path.Combine(_baseModFolder, BasePluginName);
            var baseMod = new Fallout4Mod(ModKey.FromFileName(BasePluginName), Fallout4Release.Fallout4);
            var baseQuest = new Quest(baseMod) { EditorID = "BaseQuest" };
            var baseTopic = new DialogTopic(baseMod) { EditorID = "BaseTopic" };
            baseTopic.Responses.Add(new DialogResponses(baseMod) { EditorID = "BaseResponse" });
            baseQuest.DialogTopics.Add(baseTopic);
            baseQuest.DialogBranches.Add(new DialogBranch(baseMod) { EditorID = "BaseBranch" });
            baseQuest.Scenes.Add(new Scene(baseMod) { EditorID = "BaseScene" });
            baseMod.Quests.Add(baseQuest);
            baseMod.WriteToBinary(basePath);
            (Quest, BaseTopic) = (baseQuest.FormKey, baseTopic.FormKey);

            var injectorPath = Path.Combine(_injectorModFolder, InjectorPluginName);
            var injectorMod = new Fallout4Mod(ModKey.FromFileName(InjectorPluginName), Fallout4Release.Fallout4);
            // The override carries the base's own FormKey, which is what makes InjectionBase.esm a
            // master (ADR-0038: masters are lifecycle-derived, never declared).
            var questOverride = new Quest(Quest, Fallout4Release.Fallout4) { EditorID = "BaseQuest" };
            var topicOverride = new DialogTopic(BaseTopic, Fallout4Release.Fallout4) { EditorID = "BaseTopic" };
            var injectedResponse = new DialogResponses(injectorMod) { EditorID = "InjectedResponse" };
            var injectedTopic = new DialogTopic(injectorMod) { EditorID = "InjectedTopic" };
            var injectedBranch = new DialogBranch(injectorMod) { EditorID = "InjectedBranch" };
            var injectedScene = new Scene(injectorMod) { EditorID = "InjectedScene" };
            topicOverride.Responses.Add(injectedResponse);
            questOverride.DialogTopics.Add(topicOverride);
            questOverride.DialogTopics.Add(injectedTopic);
            questOverride.DialogBranches.Add(injectedBranch);
            questOverride.Scenes.Add(injectedScene);
            injectorMod.Quests.Add(questOverride);
            injectorMod.WriteToBinary(injectorPath);
            (InjectedTopic, InjectedBranch, InjectedScene, InjectedResponse) =
                (injectedTopic.FormKey, injectedBranch.FormKey, injectedScene.FormKey, injectedResponse.FormKey);

            Mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)Mirror).Reconcile(
                _gameDirectory,
                [
                    new LoadOrderEntry(BasePluginName, basePath, BaseOrigin, Slot: 0, Enabled: true, Winning: true),
                    new LoadOrderEntry(InjectorPluginName, injectorPath, InjectorOrigin, Slot: 1, Enabled: true, Winning: true),
                ],
                GameRelease.Fallout4);
        }

        public (FormKey Container, FormKey Child, string RecordType) Case(string injection) => injection switch
        {
            TopicUnderQuest => (Quest, InjectedTopic, "dial"),
            BranchUnderQuest => (Quest, InjectedBranch, "dlbr"),
            SceneUnderQuest => (Quest, InjectedScene, "scen"),
            ResponseUnderTopic => (BaseTopic, InjectedResponse, "info"),
            _ => throw new ArgumentOutOfRangeException(nameof(injection), injection, "No such injection case."),
        };

        public IReadOnlyList<ContainerChildSummary> Children(PluginKey plugin, FormKey container) =>
            new ContainerChildQueryService(Mirror.Projector).GetChildren(plugin.Name, container.ToString(), plugin.Origin);

        public void TrackBoth()
        {
            var track = new TrackService(NullLogger<TrackService>.Instance);
            foreach (var origin in new[] { BaseOrigin, InjectorOrigin })
                track.TrackAsync(Mirror.LoadOrder!, origin, SourcePreset.Edits).GetAwaiter().GetResult();
        }

        public IModDisposeGetter CompileAndReimport(PluginKey plugin)
        {
            var result = new PluginCompileService(
                    Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance)
                .Compile(plugin, new CompileSource.WorkingTree());
            Assert.True(result.Succeeded, result.RefusalReason);

            var folder = plugin == Base ? _baseModFolder : _injectorModFolder;
            return ModFactory.ImportGetter(
                new ModPath(ModKey.FromFileName(plugin.Name), Path.Combine(folder, plugin.Name)), GameRelease.Fallout4);
        }

        public void Dispose()
        {
            Mirror.Dispose();
            TryDelete(_baseModFolder);
            TryDelete(_injectorModFolder);
            TryDelete(_gameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
