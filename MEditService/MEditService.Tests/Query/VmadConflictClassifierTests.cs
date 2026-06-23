using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;

namespace MEditService.Tests.Query;

public sealed class VmadConflictClassifierTests
{
    private static VmadPropertyValue Scalar(string type, object? value) => new(type, "", value);

    private static VmadPropertyValue StructVal(params VmadNamedValue[] members) =>
        new("Struct", "", null, Members: members);

    private static VmadPropertyValue Arr(string elemType, params object?[] values) =>
        new("ArrayOf" + elemType, "", null,
            ListItems: values.Select(v => new VmadPropertyValue(elemType, "", v)).ToList());

    private static VmadPropertyValue ObjVal(string formKey, short alias) =>
        new("Object", "", formKey, alias);

    private static VmadPropertyValue StructListVal(params VmadNamedValue[][] instances) =>
        new("ArrayOfStruct", "", null,
            StructList: instances.Select(m => (IReadOnlyList<VmadNamedValue>)m).ToList());

    private static VmadNamedValue Prop(string name, VmadPropertyValue value) => new(name, value);

    private static VmadScriptData Script(string name, string flags, params VmadNamedValue[] props) =>
        new(name, flags, props);

    private static VmadPluginInput Input(string plugin, int loadOrder, params VmadScriptData[] scripts) =>
        new(plugin, loadOrder, new VmadData(scripts));

    [Fact]
    public void Classify_DifferingScalarProperty_MarksWinnerAndLoserConflicted()
    {
        var a = Input("A.esp", 0, Script("S", "Local", Prop("Power", Scalar("Int", 10))));
        var b = Input("B.esp", 1, Script("S", "Local", Prop("Power", Scalar("Int", 20))));
        var c = Input("C.esp", 2, Script("S", "Local", Prop("Power", Scalar("Int", 30))));

        var result = VmadConflictClassifier.Classify([a, b, c]);

        var script = Assert.Single(result.Compare.Scripts);
        Assert.Equal("S", script.Name);
        var power = Assert.Single(script.Properties);
        Assert.Equal("Power", power.Name);
        Assert.Equal("C.esp", power.WinnerPlugin);

        Assert.Equal(ConflictThis.ConflictWins, power.CellStates["C.esp"]);
        Assert.Equal(ConflictThis.ConflictLoses, power.CellStates["B.esp"]);
        Assert.False(power.CellStates.ContainsKey("A.esp")); // master omitted

        Assert.Equal(ConflictAll.Conflict, result.ConflictContribution);
    }

    [Fact]
    public void Classify_ScriptPresentInOnePluginOnly_ReflectsAbsenceAndClassifiesOverride()
    {
        var a = Input("A.esp", 0, Script("Keep", "Local"));
        var b = Input("B.esp", 1, Script("Keep", "Local"), Script("Added", "Local"));

        var result = VmadConflictClassifier.Classify([a, b]);

        var added = result.Compare.Scripts.First(s => s.Name == "Added");
        Assert.Null(added.Flags["A.esp"]);          // absent column reflected
        Assert.Equal("Local", added.Flags["B.esp"]);
        Assert.Equal("B.esp", added.WinnerPlugin);
        Assert.Equal(ConflictThis.Override, added.CellStates["B.esp"]);
        Assert.False(added.CellStates.ContainsKey("A.esp"));
    }

    [Fact]
    public void Classify_SamePropertyDifferentType_IsConflict()
    {
        var a = Input("A.esp", 0, Script("S", "Local", Prop("P", Scalar("Int", 5))));
        var b = Input("B.esp", 1, Script("S", "Local", Prop("P", Scalar("Int", 5))));
        var c = Input("C.esp", 2, Script("S", "Local", Prop("P", Scalar("String", "5"))));

        var result = VmadConflictClassifier.Classify([a, b, c]);

        var p = result.Compare.Scripts[0].Properties.First(x => x.Name == "P");
        Assert.Equal("Int", p.Types["A.esp"]);
        Assert.Equal("String", p.Types["C.esp"]);
        Assert.Equal(ConflictThis.ConflictWins, p.CellStates["C.esp"]);
        Assert.Equal(ConflictAll.Conflict, result.ConflictContribution);
    }

    [Fact]
    public void Classify_StructMemberDiffers_ConflictsAtMemberLevel()
    {
        var a = Input("A.esp", 0, Script("S", "Local",
            Prop("Config", StructVal(Prop("Factor", Scalar("Float", 1f)), Prop("Scale", Scalar("Float", 2f))))));
        var b = Input("B.esp", 1, Script("S", "Local",
            Prop("Config", StructVal(Prop("Factor", Scalar("Float", 1f)), Prop("Scale", Scalar("Float", 9f))))));

        var result = VmadConflictClassifier.Classify([a, b]);

        var config = result.Compare.Scripts[0].Properties.First(p => p.Name == "Config");
        Assert.Equal("struct", config.Kind);
        Assert.Equal(ConflictThis.Override, config.CellStates["B.esp"]);     // parent reflects subtree diff
        Assert.NotNull(config.Children);

        var scale = config.Children!.First(c => c.Name == "Scale");
        var factor = config.Children!.First(c => c.Name == "Factor");
        Assert.Equal(ConflictThis.Override, scale.CellStates["B.esp"]);          // differing member
        Assert.Equal(ConflictThis.IdenticalToMaster, factor.CellStates["B.esp"]); // benign sibling
    }

    [Fact]
    public void Classify_StructProperty_CarriesPerPluginRawSubtree()
    {
        var a = Input("A.esp", 0, Script("S", "Local",
            Prop("Config", StructVal(Prop("Factor", Scalar("Float", 1.5f))))));

        var result = VmadConflictClassifier.Classify([a]);

        var config = Assert.Single(result.Compare.Scripts[0].Properties);
        Assert.Equal("struct", config.Kind);
        Assert.NotNull(config.Raw);

        var nodes = Assert.IsAssignableFrom<IReadOnlyList<VmadPropertyNode>>(config.Raw!["A.esp"]);
        var factor = Assert.Single(nodes);
        Assert.Equal("Factor", factor.Name);
        Assert.Equal("Float", factor.Type);
        Assert.Equal(1.5f, factor.FloatValue);
    }

    [Fact]
    public void Classify_ArrayOfStructProperty_CarriesPerPluginRawInstances()
    {
        var a = Input("A.esp", 0, Script("S", "Local",
            Prop("Items", StructListVal(
                [Prop("Qty", Scalar("Int", 7))],
                [Prop("Qty", Scalar("Int", 9))]))));

        var result = VmadConflictClassifier.Classify([a]);

        var items = Assert.Single(result.Compare.Scripts[0].Properties);
        Assert.Equal("structList", items.Kind);

        var instances = Assert.IsAssignableFrom<IReadOnlyList<IReadOnlyList<VmadPropertyNode>>>(items.Raw!["A.esp"]);
        Assert.Equal(2, instances.Count);
        Assert.Equal(7, Assert.Single(instances[0]).IntValue);
        Assert.Equal(9, Assert.Single(instances[1]).IntValue);
    }

    [Fact]
    public void Classify_ReorderedButEqualScriptsAndProperties_NotFlagged()
    {
        var a = Input("A.esp", 0,
            Script("Alpha", "Local", Prop("P1", Scalar("Int", 1)), Prop("P2", Scalar("Int", 2))),
            Script("Beta", "Local"));
        // Same content, scripts and properties stored in reversed order.
        var b = Input("B.esp", 1,
            Script("Beta", "Local"),
            Script("Alpha", "Local", Prop("P2", Scalar("Int", 2)), Prop("P1", Scalar("Int", 1))));

        var result = VmadConflictClassifier.Classify([a, b]);

        Assert.Equal(ConflictAll.NoConflict, result.ConflictContribution);
        Assert.All(result.Compare.Scripts, s =>
        {
            Assert.True(s.CellStates.Values.All(c => c == ConflictThis.IdenticalToMaster));
            Assert.All(s.Properties, p =>
                Assert.True(p.CellStates.Values.All(c => c == ConflictThis.IdenticalToMaster)));
        });
    }

    [Fact]
    public void Classify_ArrayElementDiffers_ConflictsAtElementIndex()
    {
        var a = Input("A.esp", 0, Script("S", "Local", Prop("Arr", Arr("Int", 1, 2))));
        var b = Input("B.esp", 1, Script("S", "Local", Prop("Arr", Arr("Int", 1, 9))));

        var result = VmadConflictClassifier.Classify([a, b]);

        var arr = result.Compare.Scripts[0].Properties.First(p => p.Name == "Arr");
        Assert.Equal("array", arr.Kind);
        Assert.Equal(ConflictThis.Override, arr.CellStates["B.esp"]);   // parent reflects element diff
        Assert.NotNull(arr.Children);
        Assert.Equal(ConflictThis.IdenticalToMaster, arr.Children![0].CellStates["B.esp"]); // [0] same
        Assert.Equal(ConflictThis.Override, arr.Children![1].CellStates["B.esp"]);          // [1] differs
    }

    [Fact]
    public void Classify_DifferingScriptFlags_ClassifiesScriptRowConflict()
    {
        var a = Input("A.esp", 0, Script("S", "Local"));
        var b = Input("B.esp", 1, Script("S", "Inherited"));

        var result = VmadConflictClassifier.Classify([a, b]);

        var script = Assert.Single(result.Compare.Scripts);
        Assert.Equal(ConflictThis.Override, script.CellStates["B.esp"]);
        Assert.Equal(ConflictAll.Override, result.ConflictContribution);
    }

    [Fact]
    public void Classify_NonWinnerEqualToWinner_IsUncontestedOverrideNotConflict()
    {
        var a = Input("A.esp", 0, Script("S", "Local", Prop("P", Scalar("Int", 1))));
        var b = Input("B.esp", 1, Script("S", "Local", Prop("P", Scalar("Int", 2))));
        var c = Input("C.esp", 2, Script("S", "Local", Prop("P", Scalar("Int", 2))));

        var result = VmadConflictClassifier.Classify([a, b, c]);

        var p = result.Compare.Scripts[0].Properties.First(x => x.Name == "P");
        Assert.Equal(ConflictThis.Override, p.CellStates["B.esp"]); // differs from master, equals winner
        Assert.Equal(ConflictThis.Override, p.CellStates["C.esp"]); // winner, uncontested
        Assert.Equal(ConflictAll.Override, result.ConflictContribution);
    }

    [Fact]
    public void Classify_DisjointPropertiesWithinScript_AlignsBothByPresence()
    {
        var a = Input("A.esp", 0, Script("S", "Local", Prop("P1", Scalar("Int", 1))));
        var b = Input("B.esp", 1, Script("S", "Local", Prop("P2", Scalar("Int", 2))));

        var result = VmadConflictClassifier.Classify([a, b]);

        var props = result.Compare.Scripts[0].Properties;
        var p1 = props.First(p => p.Name == "P1");
        var p2 = props.First(p => p.Name == "P2");
        Assert.Equal(1, p1.Values["A.esp"]);
        Assert.Null(p1.Values["B.esp"]);                    // B's script lacks P1
        Assert.Equal(ConflictThis.Override, p2.CellStates["B.esp"]); // B adds P2 over absent master
    }

    [Fact]
    public void Classify_DisjointStructMembers_AlignsBothByPresence()
    {
        var a = Input("A.esp", 0, Script("S", "Local",
            Prop("Config", StructVal(Prop("X", Scalar("Int", 1))))));
        var b = Input("B.esp", 1, Script("S", "Local",
            Prop("Config", StructVal(Prop("Y", Scalar("Int", 2))))));

        var result = VmadConflictClassifier.Classify([a, b]);

        var config = result.Compare.Scripts[0].Properties.First(p => p.Name == "Config");
        Assert.Contains(config.Children!, c => c.Name == "X");
        Assert.Contains(config.Children!, c => c.Name == "Y");
    }

    [Fact]
    public void Classify_AlignsScriptsPropertiesAndMembers_InSortedOrder()
    {
        var a = Input("A.esp", 0,
            Script("Beta", "Local"),
            Script("Alpha", "Local",
                Prop("Zeta", Scalar("Int", 1)),
                Prop("Config", StructVal(Prop("Mid", Scalar("Int", 2)), Prop("Aaa", Scalar("Int", 3))))));
        var b = Input("B.esp", 1,
            Script("Beta", "Local"),
            Script("Alpha", "Local",
                Prop("Zeta", Scalar("Int", 1)),
                Prop("Config", StructVal(Prop("Mid", Scalar("Int", 2)), Prop("Aaa", Scalar("Int", 3))))));

        var result = VmadConflictClassifier.Classify([a, b]);

        Assert.Equal(new[] { "Alpha", "Beta" }, result.Compare.Scripts.Select(s => s.Name));
        var alpha = result.Compare.Scripts.First(s => s.Name == "Alpha");
        Assert.Equal(new[] { "Config", "Zeta" }, alpha.Properties.Select(p => p.Name));
        var config = alpha.Properties.First(p => p.Name == "Config");
        Assert.Equal(new[] { "Aaa", "Mid" }, config.Children!.Select(c => c.Name));
    }

    [Fact]
    public void Classify_ObjectProperty_ExposesFormKeyAliasLeafValue()
    {
        var a = Input("A.esp", 0, Script("S", "Local", Prop("Ref", ObjVal("000800:Base.esp", 1))));
        var b = Input("B.esp", 1, Script("S", "Local", Prop("Ref", ObjVal("000900:Base.esp", 2))));

        var result = VmadConflictClassifier.Classify([a, b]);

        var refProp = result.Compare.Scripts[0].Properties.First(p => p.Name == "Ref");
        Assert.Equal("object", refProp.Kind);
        Assert.Equal("000800:Base.esp [1]", refProp.Values["A.esp"]);
        Assert.Equal("000900:Base.esp [2]", refProp.Values["B.esp"]);
        Assert.Equal(ConflictThis.Override, refProp.CellStates["B.esp"]);
    }

    [Fact]
    public void Classify_ArrayOfStructMemberDiffers_ConflictsWithinInstance()
    {
        var a = Input("A.esp", 0, Script("S", "Local",
            Prop("Items", StructListVal([Prop("Qty", Scalar("Int", 1))]))));
        var b = Input("B.esp", 1, Script("S", "Local",
            Prop("Items", StructListVal([Prop("Qty", Scalar("Int", 9))]))));

        var result = VmadConflictClassifier.Classify([a, b]);

        var items = result.Compare.Scripts[0].Properties.First(p => p.Name == "Items");
        Assert.Equal("structList", items.Kind);
        Assert.Equal(ConflictThis.Override, items.CellStates["B.esp"]);          // parent reflects diff
        var qty = items.Children![0].Children!.First(c => c.Name == "Qty");
        Assert.Equal(ConflictThis.Override, qty.CellStates["B.esp"]);
    }

    [Fact]
    public void Classify_ArraysDifferentLength_AlignsByMaxLength()
    {
        // A has 3 elements, B has 2 — alignment must use Max not Min.
        var a = Input("A.esp", 0, Script("S", "Local", Prop("Scores", Arr("Int", 1, 2, 3))));
        var b = Input("B.esp", 1, Script("S", "Local", Prop("Scores", Arr("Int", 1, 9))));

        var result = VmadConflictClassifier.Classify([a, b]);

        var scores = result.Compare.Scripts[0].Properties.First(p => p.Name == "Scores");
        Assert.Equal(3, scores.Children!.Count);                                            // max(3,2) not min
        Assert.Equal(ConflictThis.IdenticalToMaster, scores.Children[0].CellStates["B.esp"]); // [0] same
        Assert.Equal(ConflictThis.Override, scores.Children[1].CellStates["B.esp"]);          // [1] differs
        Assert.Empty(scores.Children[2].CellStates);                                          // [2] absent in B → no state
    }

    [Fact]
    public void Classify_ArrayPropertyAbsentInOnePlugin_AlignedWithPresentPlugin()
    {
        // B has the script but not the "Scores" property at all (null in perPlugin dict).
        // IndexedChildren must handle the null entry without throwing.
        var a = Input("A.esp", 0, Script("S", "Local", Prop("Scores", Arr("Int", 1, 2))));
        var b = Input("B.esp", 1, Script("S", "Local"));

        var result = VmadConflictClassifier.Classify([a, b]);

        var scores = result.Compare.Scripts[0].Properties.First(p => p.Name == "Scores");
        Assert.Equal(2, scores.Children!.Count);
        Assert.All(scores.Children, c => Assert.False(c.CellStates.ContainsKey("B.esp")));
    }

    [Fact]
    public void Classify_StructPropertyAbsentInOnePlugin_MemberChildrenPropagateNull()
    {
        // B has the script but not the "Config" struct property (null in perPlugin dict).
        // ChildDiff must propagate null for missing plugin without throwing.
        var a = Input("A.esp", 0, Script("S", "Local",
            Prop("Config", StructVal(Prop("X", Scalar("Int", 1))))));
        var b = Input("B.esp", 1, Script("S", "Local"));

        var result = VmadConflictClassifier.Classify([a, b]);

        var config = result.Compare.Scripts[0].Properties.First(p => p.Name == "Config");
        Assert.NotNull(config.Children);
        var x = config.Children!.First(c => c.Name == "X");
        Assert.False(x.CellStates.ContainsKey("B.esp")); // absent in B → no cell state
    }

    [Fact]
    public void Classify_ObjectProperty_SameFormKeyDifferentAlias_IsConflict()
    {
        // Alias is part of the canonical value; same FormKey + different alias must register as a difference.
        var a = Input("A.esp", 0, Script("S", "Local", Prop("Ref", ObjVal("000800:Base.esp", 1))));
        var b = Input("B.esp", 1, Script("S", "Local", Prop("Ref", ObjVal("000800:Base.esp", 2))));

        var result = VmadConflictClassifier.Classify([a, b]);

        var refProp = result.Compare.Scripts[0].Properties.First(p => p.Name == "Ref");
        Assert.Equal(ConflictThis.Override, refProp.CellStates["B.esp"]);
        Assert.Equal(ConflictAll.Override, result.ConflictContribution);
    }

    // --- Canon unit tests (Canon is internal) ---

    [Fact]
    public void Canon_StructMembers_SortedAlphabeticallyRegardlessOfInputOrder()
    {
        // Verifies OrderBy(Name) not OrderByDescending: members stored as [Z, A] must produce
        // "Struct{A=...,Z=...}" not "Struct{Z=...,A=...}".
        var v = new VmadPropertyValue("Struct", "", null,
            Members: [new VmadNamedValue("Z", Scalar("Int", 1)), new VmadNamedValue("A", Scalar("Int", 2))]);
        Assert.Equal("Struct{A=Int|2,Z=Int|1}", VmadConflictClassifier.Canon(v));
    }

    [Fact]
    public void Canon_StructListInstances_MembersSortedAlphabetically()
    {
        // Verifies OrderBy(Name) in struct-list instances: [Z, A] → {A=...,Z=...}.
        var inst = new VmadNamedValue[] {
            new("Z", Scalar("Int", 9)), new("A", Scalar("Int", 7))
        };
        var v = new VmadPropertyValue("ArrayOfStruct", "", null,
            StructList: [(IReadOnlyList<VmadNamedValue>)inst]);
        Assert.Equal("ArrayOfStruct[{A=Int|7,Z=Int|9}]", VmadConflictClassifier.Canon(v));
    }

    [Fact]
    public void Canon_ScalarTypes_DoNotGetAliasSuffix()
    {
        // Verifies the conditional is v.Type == "Object" (not always-true): non-Object scalars
        // must produce "Type|value" not "Type|value []".
        Assert.Equal("Int|42", VmadConflictClassifier.Canon(Scalar("Int", 42)));
        Assert.Equal("Bool|True", VmadConflictClassifier.Canon(Scalar("Bool", true)));
        Assert.Equal("Float|1.5", VmadConflictClassifier.Canon(Scalar("Float", 1.5f)));
        Assert.Equal("String|hello", VmadConflictClassifier.Canon(Scalar("String", "hello")));
    }
}
