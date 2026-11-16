using System.Text.Json.Nodes;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class ScriptReferencesTests
{
    private static readonly PluginAddress Holding = new("Holding.esp", "ModA");

    private static Npc Attaching(Fallout4Mod mod, string editorId, ScriptEntry script)
    {
        var npc = mod.Npcs.AddNew(editorId);
        npc.VirtualMachineAdapter = new VirtualMachineAdapter();
        npc.VirtualMachineAdapter.Scripts.Add(script);
        return npc;
    }

    [Fact]
    public void ACopyThatAttachesAScript_IsAReferenceToItsNameInAnyCase_AtTheMemberThatNamesIt()
    {
        string attaching = "";
        using var plugins = new PluginFixtureBuilder("script-references")
            .WithPlugin(Holding.Name, mod =>
            {
                attaching = Attaching(mod, "Holder", new ScriptEntry { Name = "Ns:Attached" }).FormKey.ToString();
                var naming = new ScriptEntry { Name = "Ns:Other" };
                naming.Properties.Add(new ScriptStringProperty { Name = "Names", Data = "Ns:Attached" });
                Attaching(mod, "Other", naming);
            }, origin: Holding.Origin)
            .BuildScattered();
        var holder = new LoadOrderHolder();
        using var opens = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, opens);
        index.Reconcile(holder, plugins.DataFolder, plugins.Plugins, GameRelease.Fallout4);

        var copies = index.Queries.GetScriptReferences("ns:ATTACHED").Value().Copies;

        var copy = Assert.Single(copies);
        Assert.Equal((attaching, Holding, false), (copy.FormKey, copy.Plugin, copy.InPluginSource));
        Assert.Equal(["VirtualMachineAdapter.Scripts[0].Name"], copy.FieldPaths);
    }

    [Fact]
    public void AScriptAttachedByAnEdit_IsAReferenceAtOnce_AndNoneOnceTheEditTakesItOut()
    {
        using var fixture = new IndexedContainerMod();
        var npc = fixture.Index.DocumentOf(fixture.Npc, fixture.Plugin);
        var body = JsonNode.Parse(fixture.Index.BodyOf(fixture.Npc, fixture.Plugin)).Require().AsObject();
        var plain = body.ToJsonString();
        body["VirtualMachineAdapter"] = new JsonObject { ["Scripts"] = new JsonArray(new JsonObject { ["Name"] = "Ns:Edited" }) };

        fixture.Index.Edit(fixture.Entry, npc, body.ToJsonString());
        var attached = fixture.Index.Queries.GetScriptReferences("Ns:Edited").Value().Copies;
        fixture.Index.Edit(fixture.Entry, npc, plain);

        Assert.Equal(["VirtualMachineAdapter.Scripts[0].Name"], Assert.Single(attached).FieldPaths);
        Assert.Empty(fixture.Index.Queries.GetScriptReferences("Ns:Edited").Value().Copies);
    }
}
