using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>
/// Fixture for delete-records API tests.
///
/// Editable.esp — owns Kw1 (referenced by immutable NPC — blocked delete)
///                  Kw2 (editable-only refs — triggers nullification on delete)
///                  standalone NPCs for safe-delete tests.
/// Fallout4.esm (implicit/immutable) — NPC referencing Kw1, blocking its deletion.
/// </summary>
public sealed class DeleteRecordsFixture : IDisposable
{
    public string DataFolder => _data.DataFolder;
    public string PluginsTxtPath => _data.PluginsTxtPath;

    public const string ImmutablePlugin = "Fallout4.esm";
    public const string EditablePlugin = "Editable.esp";

    /// <summary>Keyword in EditablePlugin referenced by Fallout4.esm NPC — deletion is blocked.</summary>
    public FormKey Kw1FormKey { get; }

    /// <summary>Keyword in EditablePlugin referenced only by an editable NPC — deletion triggers nullification.</summary>
    public FormKey Kw2FormKey { get; }

    /// <summary>NPC in EditablePlugin referencing Kw2 — its keywords field gets nullified when Kw2 is deleted.</summary>
    public FormKey EditableNpcFormKey { get; }

    /// <summary>Standalone NPC in EditablePlugin with no references — safe to delete.</summary>
    public FormKey StandaloneNpcFormKey { get; }

    /// <summary>Second standalone NPC — for batch-delete tests.</summary>
    public FormKey StandaloneNpc2FormKey { get; }

    private readonly PluginFixtureData _data;

    public DeleteRecordsFixture()
    {
        FormKey kw1 = default;
        FormKey kw2 = default;
        FormKey editNpc = default;
        FormKey standalone = default;
        FormKey standalone2 = default;

        _data = new PluginFixtureBuilder("medit-del")
            // Editable.esp first so kw1 is set before Fallout4.esm lambda captures it
            .WithPlugin(EditablePlugin, mod =>
            {
                var k1 = mod.Keywords.AddNew();
                k1.EditorID = "DelKw1_Blocked";
                kw1 = k1.FormKey;

                var k2 = mod.Keywords.AddNew();
                k2.EditorID = "DelKw2_Nullify";
                kw2 = k2.FormKey;

                var npc = mod.Npcs.AddNew("DelEditableNPC");
                npc.Keywords = [new FormLink<IKeywordGetter>(kw2)];
                editNpc = npc.FormKey;

                standalone = mod.Npcs.AddNew("DelStandalone1").FormKey;
                standalone2 = mod.Npcs.AddNew("DelStandalone2").FormKey;
            })
            // Fallout4.esm (implicit) NPC references kw1 — blocks deletion of kw1
            .WithPlugin(ImmutablePlugin, (mod, _) =>
            {
                var npc = mod.Npcs.AddNew("DelImmutableNPC");
                npc.Keywords = [new FormLink<IKeywordGetter>(kw1)];
            }, listed: false)
            .Build();

        Kw1FormKey = kw1;
        Kw2FormKey = kw2;
        EditableNpcFormKey = editNpc;
        StandaloneNpcFormKey = standalone;
        StandaloneNpc2FormKey = standalone2;
    }

    public void Dispose() => _data.Dispose();
}
