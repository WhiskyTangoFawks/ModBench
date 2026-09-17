using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Tests;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Indexing;

public class FormReferencesTests
{
    // Every reference aimed at the target, as (source, field path, record type). Each test asserts
    // the full set: another walk seeing that FormKey would push the count past one and fail.
    private static List<(string Source, string FieldPath, string RecordType)> ReferencesTo(IRecordReads reads, FormKey target) =>
        [.. reads.GetReferencedBy(target.ToString()).Select(r => (r.FormKey, r.FieldPath, r.RecordType))];

    private static (string Source, string FieldPath, string RecordType) TheReferenceTo(IRecordReads reads, FormKey target) =>
        Assert.Single(ReferencesTo(reads, target));

    [Fact]
    public void Index_ScalarFormKeyField_IsIndexedInFormReferences()
    {
        FormKey raceFormKey = default, npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-scalar")
            .WithPlugin("References.esp", mod =>
            {
                var race = mod.Races.AddNew("TestRace01");
                raceFormKey = race.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC01");
                npcFormKey = npc.FormKey;
                npc.Race.SetTo(race.FormKey);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var row = Assert.Single(ReferencesTo(index.RequireReads(), raceFormKey), r => r.FieldPath == "Race");
        Assert.Equal(npcFormKey.ToString(), row.Source);
        Assert.Equal("npc_", row.RecordType);
    }

    [Fact]
    public void Index_NoFormLinkFieldsSet_NothingReferencesItsNeighbour()
    {
        FormKey raceFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-empty")
            .WithPlugin("NoRefs.esp", mod =>
            {
                raceFormKey = mod.Races.AddNew("UnreferencedRace").FormKey;
                mod.Npcs.AddNew("BareNPC");
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        Assert.Empty(index.RequireReads().GetReferencedBy(raceFormKey.ToString()));
    }

    [Fact]
    public async Task Index_ReIndexSamePlugin_ReplacesRatherThanDuplicates()
    {
        FormKey raceFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-reindex")
            .WithPlugin("Reindex.esp", mod =>
            {
                var race = mod.Races.AddNew("TestRace01");
                raceFormKey = race.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC01");
                npc.Race.SetTo(race.FormKey);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        Assert.True(await index.RefreshBinary(new PluginCopyKey("Reindex.esp", "Data"), fixture.Plugins.Single().Path));

        Assert.Single(ReferencesTo(index.RequireReads(), raceFormKey), r => r.FieldPath == "Race");
    }

    [Fact]
    public void Index_ArrayFormKeyField_IsIndexedInFormReferences()
    {
        FormKey kwFormKey = default, npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-array-fk")
            .WithPlugin("ArrayFk.esp", mod =>
            {
                var kw = mod.Keywords.AddNew();
                kw.EditorID = "TestKw01";
                kwFormKey = kw.FormKey;

                var npc = mod.Npcs.AddNew("TestNPC_ArrayFk");
                npcFormKey = npc.FormKey;
                npc.Keywords = [new FormLink<IKeywordGetter>(kwFormKey)];
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var row = Assert.Single(ReferencesTo(index.RequireReads(), kwFormKey), r => r.FieldPath == "Keywords[0]");
        Assert.Equal(npcFormKey.ToString(), row.Source);
    }

    [Fact]
    public void Index_ArrayOfStructWithFormKeySubField_IsIndexedInFormReferences()
    {
        FormKey factionFormKey = default, npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-array-struct")
            .WithPlugin("ArrayStruct.esp", mod =>
            {
                var faction = mod.Factions.AddNew("TestFaction01");
                factionFormKey = faction.FormKey;

                var npc = mod.Npcs.AddNew("TestNPC_ArrayStruct");
                npcFormKey = npc.FormKey;
                npc.Factions.Add(new RankPlacement { Faction = new FormLink<IFactionGetter>(factionFormKey) });
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var row = Assert.Single(ReferencesTo(index.RequireReads(), factionFormKey), r => r.FieldPath == "Factions[0].Faction");
        Assert.Equal(npcFormKey.ToString(), row.Source);
    }

    [Fact]
    public void Index_VmadStructWithObjectMember_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default, npcFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-vmad-struct")
            .WithPlugin("VmadStructRef.esp", mod =>
            {
                var target = mod.Npcs.AddNew("RefTarget");
                targetFormKey = target.FormKey;

                var npc = mod.Npcs.AddNew("VmadStructNpc");
                npcFormKey = npc.FormKey;

                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var structProp = new ScriptStructProperty { Name = "Config" };
                var wrapper = new ScriptEntry();
                var objMember = new ScriptObjectProperty { Name = "TargetRef", Alias = -1 };
                objMember.Object.SetTo(targetFormKey);
                wrapper.Properties.Add(objMember);
                structProp.Members.Add(wrapper);
                script.Properties.Add(structProp);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var row = TheReferenceTo(index.RequireReads(), targetFormKey);
        Assert.Equal(npcFormKey.ToString(), row.Source);
        Assert.Equal("VirtualMachineAdapter.Scripts[0].Properties[0].Members[0].Properties[0].Object", row.FieldPath);
        Assert.Equal("npc_", row.RecordType);  // the source record's own table
    }

    [Fact]
    public void Index_VmadStructNestedInsideAStruct_IsNotWalked_TheDocumentedTruncation()
    {
        FormKey targetFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-vmad-nested-struct")
            .WithPlugin("VmadNestedStructRef.esp", mod =>
            {
                var target = mod.Npcs.AddNew("RefTarget");
                targetFormKey = target.FormKey;

                var npc = mod.Npcs.AddNew("VmadNestedStructNpc");

                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };

                // Config = Struct { Inner = Struct { TargetRef = Object } } — a shape Papyrus
                // itself cannot author (a struct member is never another struct), built here only
                // to pin where the walk stops.
                var outer = new ScriptStructProperty { Name = "Config" };
                var outerWrapper = new ScriptEntry();
                var inner = new ScriptStructProperty { Name = "Inner" };
                var innerWrapper = new ScriptEntry();
                var objMember = new ScriptObjectProperty { Name = "TargetRef", Alias = -1 };
                objMember.Object.SetTo(targetFormKey);
                innerWrapper.Properties.Add(objMember);
                inner.Members.Add(innerWrapper);
                outerWrapper.Properties.Add(inner);
                outer.Members.Add(outerWrapper);
                script.Properties.Add(outer);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        // The walk stops at the re-entry, by SchemaAnnotations.CycleTruncations' ruling: a Fallout 4
        // Papyrus struct member is never itself a struct, so the shape built above is unreachable from
        // real data and the schema does not model it.
        Assert.Empty(ReferencesTo(index.RequireReads(), targetFormKey));
    }

    [Fact]
    public void Index_VmadStructWithObjectListMember_IsIndexedInFormReferences()
    {
        FormKey target0Fk = default, target1Fk = default;
        using var fixture = new PluginFixtureBuilder("form-refs-vmad-struct-objlist")
            .WithPlugin("VmadStructObjList.esp", mod =>
            {
                var t0 = mod.Npcs.AddNew("ObjListTarget0"); target0Fk = t0.FormKey;
                var t1 = mod.Npcs.AddNew("ObjListTarget1"); target1Fk = t1.FormKey;

                var npc = mod.Npcs.AddNew("VmadObjListNpc");

                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };
                var structProp = new ScriptStructProperty { Name = "Config" };
                var wrapper = new ScriptEntry();

                var objList = new ScriptObjectListProperty { Name = "Refs" };
                var item0 = new ScriptObjectProperty { Alias = -1 }; item0.Object.SetTo(target0Fk);
                var item1 = new ScriptObjectProperty { Alias = -1 }; item1.Object.SetTo(target1Fk);
                objList.Objects.Add(item0);
                objList.Objects.Add(item1);
                wrapper.Properties.Add(objList);
                structProp.Members.Add(wrapper);
                script.Properties.Add(structProp);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        Assert.Contains(ReferencesTo(reads, target0Fk), r => r.FieldPath == "VirtualMachineAdapter.Scripts[0].Properties[0].Members[0].Properties[0].Objects[0].Object");
        Assert.Contains(ReferencesTo(reads, target1Fk), r => r.FieldPath == "VirtualMachineAdapter.Scripts[0].Properties[0].Members[0].Properties[0].Objects[1].Object");
    }

    [Fact]
    public void Index_VmadStructListProperty_IsIndexedInFormReferences()
    {
        FormKey target0Fk = default, target1Fk = default;
        using var fixture = new PluginFixtureBuilder("form-refs-vmad-struct-structlist")
            .WithPlugin("VmadStructStructList.esp", mod =>
            {
                var t0 = mod.Npcs.AddNew("StructListTarget0"); target0Fk = t0.FormKey;
                var t1 = mod.Npcs.AddNew("StructListTarget1"); target1Fk = t1.FormKey;

                var npc = mod.Npcs.AddNew("VmadStructListNpc");

                var vmad = new VirtualMachineAdapter();
                var script = new ScriptEntry { Name = "DefaultScript", Flags = ScriptEntry.Flag.Local };

                // Parts = ArrayOfStruct [ {PartRef=Object}, {PartRef=Object} ] — the shape the
                // KnownDefects RemapLinks row names.
                var parts = new ScriptStructListProperty { Name = "Parts" };

                var inst0 = new ScriptEntryStructs();
                var ref0 = new ScriptObjectProperty { Name = "PartRef", Alias = -1 };
                ref0.Object.SetTo(target0Fk);
                inst0.Members.Add(ref0);
                parts.Structs.Add(inst0);

                var inst1 = new ScriptEntryStructs();
                var ref1 = new ScriptObjectProperty { Name = "PartRef", Alias = -1 };
                ref1.Object.SetTo(target1Fk);
                inst1.Members.Add(ref1);
                parts.Structs.Add(inst1);

                script.Properties.Add(parts);
                vmad.Scripts.Add(script);
                npc.VirtualMachineAdapter = vmad;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        Assert.Contains(ReferencesTo(reads, target0Fk), r => r.FieldPath == "VirtualMachineAdapter.Scripts[0].Properties[0].Structs[0].Members[0].Object");
        Assert.Contains(ReferencesTo(reads, target1Fk), r => r.FieldPath == "VirtualMachineAdapter.Scripts[0].Properties[0].Structs[1].Members[0].Object");
    }

    // ── Scripts reachable only through an adapter sub-structure ──

    private static ScriptEntry ScriptWithObjectProperty(string scriptName, string propName, FormKey target)
    {
        var script = new ScriptEntry { Name = scriptName, Flags = ScriptEntry.Flag.Local };
        var prop = new ScriptObjectProperty { Name = propName, Alias = -1 };
        prop.Object.SetTo(target);
        script.Properties.Add(prop);
        return script;
    }

    [Fact]
    public void Index_QuestAliasScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default, questFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-quest-alias-script")
            .WithPlugin("QuestAliasScript.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("AliasScriptTarget").FormKey;
                var quest = mod.Quests.AddNew("AliasScriptQuest");
                questFormKey = quest.FormKey;

                var adapter = new QuestAdapter();
                var alias = new QuestFragmentAlias();
                alias.Scripts.Add(ScriptWithObjectProperty("AliasScript", "TargetRef", targetFormKey));
                adapter.Aliases.Add(alias);
                quest.VirtualMachineAdapter = adapter;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var row = TheReferenceTo(index.RequireReads(), targetFormKey);
        Assert.Equal(questFormKey.ToString(), row.Source);
        Assert.Equal("VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[0].Object", row.FieldPath);
        Assert.Equal("qust", row.RecordType);
    }

    [Fact]
    public void Index_QuestAliasOwnScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default, questFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-quest-alias-property")
            .WithPlugin("QuestAliasProperty.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("AliasPropertyTarget").FormKey;
                var quest = mod.Quests.AddNew("AliasPropertyQuest");
                questFormKey = quest.FormKey;

                var adapter = new QuestAdapter();
                var alias = new QuestFragmentAlias();
                alias.Property.Object.SetTo(targetFormKey);
                alias.Property.Alias = -1;
                adapter.Aliases.Add(alias);
                quest.VirtualMachineAdapter = adapter;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var row = TheReferenceTo(index.RequireReads(), targetFormKey);
        Assert.Equal(questFormKey.ToString(), row.Source);
        Assert.Equal("VirtualMachineAdapter.Aliases[0].Property.Object", row.FieldPath);
        Assert.Equal("qust", row.RecordType);
    }

    [Fact]
    public void Index_QuestFragmentScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default, questFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-quest-fragment-script")
            .WithPlugin("QuestFragmentScript.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("QuestFragmentTarget").FormKey;
                var quest = mod.Quests.AddNew("QuestFragmentQuest");
                questFormKey = quest.FormKey;

                quest.VirtualMachineAdapter = new QuestAdapter
                {
                    Script = ScriptWithObjectProperty("QuestFragments", "TargetRef", targetFormKey),
                };
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var row = TheReferenceTo(index.RequireReads(), targetFormKey);
        Assert.Equal(questFormKey.ToString(), row.Source);
        Assert.Equal("VirtualMachineAdapter.Script.Properties[0].Object", row.FieldPath);
        Assert.Equal("qust", row.RecordType);
    }

    [Fact]
    public void Index_PackageFragmentScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default, packageFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-package-fragment-script")
            .WithPlugin("PackageFragmentScript.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("PackageFragmentTarget").FormKey;
                var package = mod.Packages.AddNew("FragmentPackage");
                packageFormKey = package.FormKey;

                package.VirtualMachineAdapter = new PackageAdapter
                {
                    ScriptFragments = new PackageScriptFragments
                    {
                        Script = ScriptWithObjectProperty("PackageScript", "TargetRef", targetFormKey),
                    },
                };
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var row = TheReferenceTo(index.RequireReads(), targetFormKey);
        Assert.Equal(packageFormKey.ToString(), row.Source);
        Assert.Equal("VirtualMachineAdapter.ScriptFragments.Script.Properties[0].Object", row.FieldPath);
        Assert.Equal("pack", row.RecordType);
    }

    [Fact]
    public void Index_SceneFragmentScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default, sceneFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-scene-fragment-script")
            .WithPlugin("SceneFragmentScript.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("SceneFragmentTarget").FormKey;
                var quest = mod.Quests.AddNew("SceneOwnerQuest");
                var scene = new Scene(mod) { EditorID = "FragmentScene" };
                sceneFormKey = scene.FormKey;
                scene.VirtualMachineAdapter = new SceneAdapter
                {
                    ScriptFragments = new SceneScriptFragments
                    {
                        Script = ScriptWithObjectProperty("SceneScript", "TargetRef", targetFormKey),
                    },
                };
                quest.Scenes.Add(scene);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        // The scene's own row: it is inline in its quest's document, and its links are its own.
        var row = Assert.Single(ReferencesTo(index.RequireReads(), targetFormKey), r => r.Source == sceneFormKey.ToString());
        Assert.Equal("VirtualMachineAdapter.ScriptFragments.Script.Properties[0].Object", row.FieldPath);
        Assert.Equal("scen", row.RecordType);
    }

    // The container's document carries its embedded children, so the quest also holds the scene's link
    // at the scene's path, as a cell holds its Landscape's. Held for the user's ruling; pinned here.
    [Fact]
    public void Index_AQuest_CarriesItsInlineScenesScriptReference_AsItsOwn()
    {
        FormKey targetFormKey = default, questFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-quest-carries-scene")
            .WithPlugin("QuestCarriesScene.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("SceneFragmentTarget").FormKey;
                var quest = mod.Quests.AddNew("SceneOwnerQuest");
                questFormKey = quest.FormKey;
                var scene = new Scene(mod) { EditorID = "FragmentScene" };
                scene.VirtualMachineAdapter = new SceneAdapter
                {
                    ScriptFragments = new SceneScriptFragments
                    {
                        Script = ScriptWithObjectProperty("SceneScript", "TargetRef", targetFormKey),
                    },
                };
                quest.Scenes.Add(scene);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        var row = Assert.Single(ReferencesTo(index.RequireReads(), targetFormKey), r => r.Source == questFormKey.ToString());
        Assert.Equal("Scenes[0].VirtualMachineAdapter.ScriptFragments.Script.Properties[0].Object", row.FieldPath);
        Assert.Equal("qust", row.RecordType);
    }

    [Fact]
    public void Index_DialogInfoFragmentScriptObjectProperty_IsIndexedInFormReferences()
    {
        FormKey targetFormKey = default, responseFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-info-fragment-script")
            .WithPlugin("InfoFragmentScript.esp", mod =>
            {
                targetFormKey = mod.Npcs.AddNew("InfoFragmentTarget").FormKey;
                var quest = mod.Quests.AddNew("InfoOwnerQuest");
                var topic = new DialogTopic(mod) { EditorID = "FragmentTopic" };
                quest.DialogTopics.Add(topic);
                var response = new DialogResponses(mod) { EditorID = "FragmentResponse" };
                responseFormKey = response.FormKey;
                response.VirtualMachineAdapter = new DialogResponsesAdapter
                {
                    ScriptFragments = new ScriptFragments
                    {
                        Script = ScriptWithObjectProperty("InfoScript", "TargetRef", targetFormKey),
                    },
                };
                topic.Responses.Add(response);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        // The response's own row: it is inline in its topic's document, and its links are its own.
        var row = Assert.Single(ReferencesTo(index.RequireReads(), targetFormKey), r => r.Source == responseFormKey.ToString());
        Assert.Equal("VirtualMachineAdapter.ScriptFragments.Script.Properties[0].Object", row.FieldPath);
        Assert.Equal("info", row.RecordType);
    }

    // AC4: an adapter-reachable script's properties are walked to the same depth top-level scripts
    // are. One test covers both shapes on one alias script, so a partial walk fails here rather than
    // passing three-quarters of a suite.
    [Fact]
    public void Index_QuestAliasScriptNestedStructMembers_AreWalkedToFullDepth()
    {
        FormKey nestedTarget = default, listTarget = default, questFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-quest-alias-nested")
            .WithPlugin("QuestAliasNested.esp", mod =>
            {
                nestedTarget = mod.Npcs.AddNew("NestedTarget").FormKey;
                listTarget = mod.Npcs.AddNew("ListTarget").FormKey;
                var quest = mod.Quests.AddNew("NestedAliasQuest");
                questFormKey = quest.FormKey;

                var script = new ScriptEntry { Name = "AliasScript", Flags = ScriptEntry.Flag.Local };

                // Struct → Object
                var outer = new ScriptStructProperty { Name = "Config" };
                var outerWrapper = new ScriptEntry();
                var innerObj = new ScriptObjectProperty { Name = "DeepRef", Alias = -1 };
                innerObj.Object.SetTo(nestedTarget);
                outerWrapper.Properties.Add(innerObj);
                outer.Members.Add(outerWrapper);
                script.Properties.Add(outer);

                // ArrayOfStruct → Object
                var structList = new ScriptStructListProperty { Name = "Parts" };
                var instance = new ScriptEntryStructs();
                var listObj = new ScriptObjectProperty { Name = "PartRef", Alias = -1 };
                listObj.Object.SetTo(listTarget);
                instance.Members.Add(listObj);
                structList.Structs.Add(instance);
                script.Properties.Add(structList);

                var alias = new QuestFragmentAlias();
                alias.Scripts.Add(script);
                var adapter = new QuestAdapter();
                adapter.Aliases.Add(alias);
                quest.VirtualMachineAdapter = adapter;
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);
        var reads = index.RequireReads();

        var nestedRow = TheReferenceTo(reads, nestedTarget);
        Assert.Equal(questFormKey.ToString(), nestedRow.Source);
        Assert.Equal("VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[0].Members[0].Properties[0].Object", nestedRow.FieldPath);

        var listRow = TheReferenceTo(reads, listTarget);
        Assert.Equal(questFormKey.ToString(), listRow.Source);
        Assert.Equal("VirtualMachineAdapter.Aliases[0].Scripts[0].Properties[1].Structs[0].Members[0].Object", listRow.FieldPath);
    }
}
