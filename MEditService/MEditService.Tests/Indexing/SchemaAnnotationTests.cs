using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Tests.Indexing;

/// <summary>An annotation naming a type or member reflection did not find fails schema generation,
/// so a Mutagen rename can never leave a stale annotation silently doing nothing.</summary>
public sealed class SchemaAnnotationTests
{
    private static void AssertFailsNaming(SchemaReflector reflector, string entry)
    {
        var ex = Assert.Throws<InvalidOperationException>(() => reflector.GetSchemas(GameRelease.Fallout4));
        Assert.Contains(entry, ex.Message, StringComparison.Ordinal);
    }

    [Theory]
    [InlineData("INpcGetter", "NoSuchMember")]   // the type resolves, the member does not
    [InlineData("INoSuchGetter", "Name")]        // the type does not resolve at all
    public void ExcludedMember_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(string type, string member)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { ExcludedMembers = [.. a.ExcludedMembers, (type, member)] });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Theory]
    [InlineData("ICellGetter", "NoSuchMember")]
    [InlineData("INoSuchGetter", "Timestamp")]
    public void ExcludedColumn_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(string type, string member)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { ExcludedColumns = [.. a.ExcludedColumns, (type, member)] });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Theory]
    [InlineData("IKeywordGetter", "NoSuchMember")]
    [InlineData("INoSuchGetter", "Color")]
    public void AlphaBearingColorField_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(string type, string member)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { AlphaBearingColorFields = [.. a.AlphaBearingColorFields, (type, member)] });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Theory]
    [InlineData("IScriptEntryGetter", "NoSuchMember", "Name", "IScriptEntryGetter.NoSuchMember")]
    [InlineData("INoSuchGetter", "Properties", "Name", "INoSuchGetter.Properties")]
    // The member resolves but is not a list at all — a key means nothing without elements to key.
    [InlineData("IScriptEntryGetter", "Name", "Name", "IScriptEntryGetter.Name is not a list")]
    // The key names a member its element does not have. This fails quietly without validation: every
    // element would share the empty key, collapsing the array to one compare row and refusing every
    // second element as a duplicate on write.
    [InlineData("IScriptEntryGetter", "Properties", "no_such_key", "names key no_such_key, which IScriptPropertyGetter does not reach at no_such_key")]
    // A key that reaches a list rather than a value — one element, one key.
    [InlineData("IAVirtualMachineAdapterGetter", "Scripts", "Properties", "which is itself a list")]
    // A dotted key whose first hop is a scalar, so there is nothing to descend into.
    [InlineData("IAVirtualMachineAdapterGetter", "Scripts", "name.alias", "whose name hop is not a struct to descend into")]
    public void KeyedArray_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(
        string type, string member, string key, string expected)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            KeyedArrays = new(a.KeyedArrays) { [(type, member)] = new[] { key } },
        });
        AssertFailsNaming(reflector, expected);
    }

    [Fact]
    public void ExcludedUnion_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { ExcludedUnions = [.. a.ExcludedUnions, "ANoSuchUnion"] });
        AssertFailsNaming(reflector, "ANoSuchUnion");
    }

    [Fact]
    public void EmptySubSchemaType_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { EmptySubSchemaTypes = [.. a.EmptySubSchemaTypes, "INoSuchGetter"] });
        AssertFailsNaming(reflector, "INoSuchGetter");
    }

    // A SiblingsInUse row is three claims about the assembly at once: the governing member exists, its
    // domain has the values the map is keyed by, and the members it names are real. One wrong claim
    // would silently govern nothing.

    [Theory]
    [InlineData("IFunctionConditionDataGetter", "NoSuchMember")]
    [InlineData("INoSuchGetter", "Function")]
    public void SiblingsInUse_GoverningMemberReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(string type, string member)
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SiblingsInUse = new(a.SiblingsInUse) { [(type, member)] = new Dictionary<string, IReadOnlyList<string>>() },
        });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Fact]
    public void SiblingsInUse_GoverningFromANonEnumMember_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SiblingsInUse = new(a.SiblingsInUse)
            {
                [("IFunctionConditionDataGetter", "ParameterOneString")] = new Dictionary<string, IReadOnlyList<string>>(),
            },
        });
        AssertFailsNaming(reflector, "IFunctionConditionDataGetter.ParameterOneString governs from a non-enum member (String)");
    }

    [Fact]
    public void SiblingsInUse_NamingAValueTheDomainDoesNotHave_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SiblingsInUse = new(a.SiblingsInUse)
            {
                [("IConditionDataGetter", "RunOnType")] =
                    Fallout4ConditionAnnotations.RunOnReference
                        .Append(new KeyValuePair<string, IReadOnlyList<string>>("NoSuchRunOn", []))
                        .ToDictionary(kv => kv.Key, kv => kv.Value),
            },
        });
        AssertFailsNaming(reflector, "IConditionDataGetter.RunOnType names value NoSuchRunOn, which RunOnType does not have");
    }

    [Fact]
    public void SiblingsInUse_OmittingAValueTheDomainHas_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SiblingsInUse = new(a.SiblingsInUse)
            {
                [("IConditionDataGetter", "RunOnType")] =
                    Fallout4ConditionAnnotations.RunOnReference
                        .Where(kv => kv.Key != nameof(Condition.RunOnType.MyKiller))
                        .ToDictionary(kv => kv.Key, kv => kv.Value),
            },
        });
        AssertFailsNaming(reflector, "IConditionDataGetter.RunOnType does not name value MyKiller, which RunOnType has");
    }

    [Fact]
    public void SiblingsInUse_NamingASiblingTheTypeDoesNotDeclare_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with
        {
            SiblingsInUse = new(a.SiblingsInUse)
            {
                [("IConditionDataGetter", "RunOnType")] =
                    Fallout4ConditionAnnotations.RunOnReference
                        .ToDictionary(kv => kv.Key, kv => kv.Key == "Reference" ? (IReadOnlyList<string>)["no_such_sibling"] : kv.Value),
            },
        });
        AssertFailsNaming(reflector, "IConditionDataGetter.RunOnType names sibling no_such_sibling, which IConditionDataGetter does not declare");
    }

    [Fact]
    public void ShippedFallout4Table_EveryEntryResolves()
    {
        // The production table, through the production seam: a stale row fails here, not in a user's
        // first load.
        var schemas = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);
        Assert.NotEmpty(schemas);
    }
}
