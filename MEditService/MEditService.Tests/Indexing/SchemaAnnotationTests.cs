using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #698: every hand-written per-game fact the reflector needs is an entry in
/// <see cref="SchemaAnnotations"/>, validated when the game's schema is built. An entry naming a
/// type or member reflection did not find fails schema generation and names the entry, so a
/// Mutagen rename can never leave a stale annotation silently doing nothing.
/// </summary>
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
        var reflector = VmadReflectedSchemaReflector.Fallout4With(a => a with { ExcludedMembers = [.. a.ExcludedMembers, (type, member)] });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Theory]
    [InlineData("ICellGetter", "NoSuchMember")]
    [InlineData("INoSuchGetter", "Timestamp")]
    public void ExcludedColumn_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(string type, string member)
    {
        var reflector = VmadReflectedSchemaReflector.Fallout4With(a => a with { ExcludedColumns = [.. a.ExcludedColumns, (type, member)] });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Theory]
    [InlineData("IKeywordGetter", "NoSuchMember")]
    [InlineData("INoSuchGetter", "Color")]
    public void AlphaBearingColorField_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry(string type, string member)
    {
        var reflector = VmadReflectedSchemaReflector.Fallout4With(a => a with { AlphaBearingColorFields = [.. a.AlphaBearingColorFields, (type, member)] });
        AssertFailsNaming(reflector, $"{type}.{member}");
    }

    [Fact]
    public void ExcludedUnion_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = VmadReflectedSchemaReflector.Fallout4With(a => a with { ExcludedUnions = [.. a.ExcludedUnions, "ANoSuchUnion"] });
        AssertFailsNaming(reflector, "ANoSuchUnion");
    }

    [Fact]
    public void EmptySubSchemaType_ReflectionDidNotFind_FailsSchemaGenerationNamingTheEntry()
    {
        var reflector = VmadReflectedSchemaReflector.Fallout4With(a => a with { EmptySubSchemaTypes = [.. a.EmptySubSchemaTypes, "INoSuchGetter"] });
        AssertFailsNaming(reflector, "INoSuchGetter");
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
