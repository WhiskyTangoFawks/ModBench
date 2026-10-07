using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A real tracked mod folder and the load order value over it, and nothing else: compile
/// reads only those (ADR-0015).</summary>
public sealed class CompileFixture : TestInstance, ITrackedPlugin
{
    public const string Origin = "CompileMod";
    public const string PluginName = "Compile.esp";
    public const string NpcEditorId = "FixtureNpc";
    public const string OtherNpcEditorId = "UntouchedNpc";
    public const string NpcRecordType = "npc_";

    private const GameRelease Release = GameRelease.Fallout4;

    public string ModFolder => FolderOf(Origin);
    public PluginAddress Plugin { get; }

    // Keyword is a valid target for the NPC's keywords field and Race a resolvable target of the
    // wrong type, so both FormLink error axes are reachable without inventing data mid-test.
    public FormKey Npc { get; }
    public FormKey Race { get; }
    public FormKey Keyword { get; }
    public FormKey OtherNpc { get; }

    public CompileFixture()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        var keyword = mod.Keywords.AddNew("FixtureKeyword");
        var npc = mod.Npcs.AddNew(NpcEditorId);
        npc.Race.SetTo(race);
        var otherNpc = mod.Npcs.AddNew(OtherNpcEditorId);
        Plugin = Add(mod, Origin);
        (Npc, Race, Keyword, OtherNpc) = (npc.FormKey, race.FormKey, keyword.FormKey, otherNpc.FormKey);
    }

    private string PluginPath => Path.Combine(ModFolder, PluginName);

    private SourceRepository Repository => RepositoryOf(Plugin).Require();

    public CompilePluginHandler CompileService() => CompileServices.Over(LoadOrder);

    public IFallout4ModGetter Reimport(out IDisposable handle)
    {
        var overlay = ModFactory.ImportGetter(new ModPath(ModKey.FromFileName(PluginName), PluginPath), Release);
        handle = overlay;
        return (IFallout4ModGetter)overlay;
    }

    public void Rewrite<T>(FormKey formKey, string recordType, string? editorId, Action<T> change)
        where T : class, IMajorRecord =>
        SourceEdits.Rewrite(Repository, Plugin, new RecordIdentity(formKey.ToString(), recordType, editorId), Release, change);

    public void Write(IMajorRecordGetter record, string recordType) =>
        SourceEdits.Write(Repository, Plugin, record, recordType, Release);

    public FormKey ChangeFormId(FormKey formKey, uint newId)
    {
        var moved = FormKey.Factory($"{newId:X6}:{PluginName}");
        var result = EditHandler.SetFormId(Plugin, formKey.ToString(), moved.ToString());
        Assert.True(result.Applied, result.Message);
        return moved;
    }

    public FormKey CreateNpc(string editorId, uint id)
    {
        var npc = new Npc(FormKey.Factory($"{id:X6}:{PluginName}"), Fallout4Release.Fallout4) { EditorID = editorId };
        Write(npc, NpcRecordType);
        return npc.FormKey;
    }

    public void Remove(FormKey formKey, string recordType, string? editorId) =>
        Repository.Remove(Plugin, new RecordIdentity(formKey.ToString(), recordType, editorId));

    public RecordIdentity NpcIdentity => new(Npc.ToString(), NpcRecordType, NpcEditorId);
}
