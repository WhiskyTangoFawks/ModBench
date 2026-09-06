using System.Collections.Concurrent;
using System.Reflection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Schema;

/// <summary>The reflected record schema for one game, built once per category and cached. The front
/// door to this folder: the modules alongside decide what one property becomes, and nothing outside
/// calls them directly.</summary>
public sealed class SchemaReflector
{
    private readonly ILogger _logger;
    private readonly Func<GameCategory, SchemaAnnotations> _annotationsFor;

    public SchemaReflector(ILogger<SchemaReflector>? logger = null) : this(SchemaAnnotations.For, logger) { }

    /// <summary>Test seam: the annotation tables to overlay, in place of the shipped ones.</summary>
    internal SchemaReflector(Func<GameCategory, SchemaAnnotations> annotationsFor, ILogger<SchemaReflector>? logger = null)
    {
        _annotationsFor = annotationsFor;
        // Stryker disable once NullCoalescing: logger init; only usage is a defensive LogTrace in catch — unreachable from tests without artificial exception injection
        _logger = logger ?? NullLogger<SchemaReflector>.Instance;
    }

    private sealed record GameSchemaCache(
        IReadOnlyDictionary<string, RecordTableSchema> Schemas,
        GameReflection Game);

    private readonly ConcurrentDictionary<GameCategory, GameSchemaCache> _cache = new();

    // Keyed by category because the assembly is category-wide; a null entry means the assembly was
    // probed once and found unreferenced, so a repeated ask never re-logs.
    private readonly ConcurrentDictionary<GameCategory, Assembly?> _assemblyByCategory = new();

    public IReadOnlyDictionary<string, RecordTableSchema> GetSchemas(GameRelease release)
    {
        var category = release.ToCategory();
        var assembly = ResolveAssembly(release, category)
            ?? throw new UnsupportedGameReleaseException(release, AssemblyNameFor(category));
        return GetCache(category, assembly).Schemas;
    }

    /// <summary>Never throws. Discovery walking several installs asks this before
    /// <see cref="GetSchemas"/> to decide whether a release is offered at all.</summary>
    public bool IsSupported(GameRelease release) => ResolveAssembly(release, release.ToCategory()) is not null;

    private static string AssemblyNameFor(GameCategory category) => $"Mutagen.Bethesda.{category}";

    // Never throws: FileNotFoundException from Assembly.Load means "not referenced in this build" and
    // is cached as null with one warning; GetSchemas turns that into a typed refusal.
    private Assembly? ResolveAssembly(GameRelease release, GameCategory category) =>
        _assemblyByCategory.GetOrAdd(category, c => ProbeAssembly(release, c, _logger));

    private static Assembly? ProbeAssembly(GameRelease release, GameCategory category, ILogger logger)
    {
        var assemblyName = AssemblyNameFor(category);
        var loaded = AppDomain.CurrentDomain.GetAssemblies()
            .FirstOrDefault(a => a.GetName().Name == assemblyName);
        if (loaded != null) return loaded;

        try
        {
            return Assembly.Load(assemblyName);
        }
        catch (FileNotFoundException ex)
        {
            logger.LogWarning(ex,
                "Game release {Release} is unavailable: Mutagen assembly {AssemblyName} is not referenced in this build",
                release, assemblyName);
            return null;
        }
    }

    private GameSchemaCache GetCache(GameCategory category, Assembly assembly) =>
        _cache.GetOrAdd(category, c => BuildForCategory(c, assembly, _annotationsFor(c), _logger));

    private static GameSchemaCache BuildForCategory(
        GameCategory category, Assembly assembly, SchemaAnnotations annotations, ILogger logger)
    {
        var majorRecordGetterType =
            assembly.GetType($"Mutagen.Bethesda.{category}.I{category}MajorRecordGetter")!;
        var grups = GrupRecordTypes(assembly, majorRecordGetterType, category).ToList();

        annotations.Validate(assembly, grups.Select(g => g.TableName));

        // One GRUP signature can be backed by several concrete subclasses (GMST, GLOB, DMGT) because
        // the discriminant lives on the record, not the table. One winner per table keeps RecordType
        // bound; siblingsByTable keeps every subclass so BuildSchema can union their columns.
        var seenTables = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var discovered = new List<(string tableName, Type getterType)>();
        var siblingsByTable = new Dictionary<string, List<Type>>(StringComparer.OrdinalIgnoreCase);

        foreach (var (tableName, getterInterface) in grups)
        {
            if (annotations.IsExcludedSignature(tableName)) continue;

            if (!siblingsByTable.TryGetValue(tableName, out var siblings))
                siblingsByTable[tableName] = siblings = [];
            siblings.Add(getterInterface);

            if (!seenTables.Add(tableName)) continue;

            discovered.Add((tableName, getterInterface));
        }

        // Every sibling resolves to its table, not just the winner, or a FormLink to a non-winning
        // sibling would fail to resolve its ValidFormKeyTypes.
        var game = new GameReflection(
            siblingsByTable
                .SelectMany(kv => kv.Value.Select(t => (Type: t, Table: kv.Key)))
                .ToDictionary(x => x.Type, x => x.Table),
            annotations,
            new DeclaredDefaults(category.DefaultRelease(), logger));

        var schemas = new Dictionary<string, RecordTableSchema>();
        foreach (var (tableName, getterType) in discovered)
        {
            schemas[tableName] = BuildSchema(
                tableName, getterType, siblingsByTable[tableName], game, logger);
        }

        ModHeaderSchema.AddHeaderSchemaIfAvailable(schemas, category, assembly, game, logger);

        annotations.ValidateObserved(assembly.GetName().Name ?? category.ToString(), game.Observed);

        return new GameSchemaCache(schemas, game);
    }

    // Every concrete record class the assembly registers under a GRUP, paired with its own getter
    // interface. The annotation table's signature rows are checked against this before it is read.
    private static IEnumerable<(string TableName, Type GetterInterface)> GrupRecordTypes(
        Assembly assembly, Type majorRecordGetterType, GameCategory category)
    {
        foreach (var type in assembly.GetTypes())
        {
            if (type.IsAbstract || type.IsInterface) continue;
            if (!majorRecordGetterType.IsAssignableFrom(type)) continue;

            var grupField = type.GetField("GrupRecordType", BindingFlags.Public | BindingFlags.Static);
            if (grupField == null) continue;

            yield return (
                ((RecordType)grupField.GetValue(null)!).Type.ToLowerInvariant(),
                assembly.GetType($"Mutagen.Bethesda.{category}.I{type.Name}Getter")!);
        }
    }

    /// <summary>The known Mutagen defects with one effect, for the gesture that has to honour
    /// them. Building the schema is what validates the rows.</summary>
    internal IReadOnlyList<KnownDefect> DefectsWith(GameRelease release, KnownDefectEffect effect)
    {
        var category = release.ToCategory();
        var assembly = ResolveAssembly(release, category)
            ?? throw new UnsupportedGameReleaseException(release, AssemblyNameFor(category));
        return GetCache(category, assembly).Game.Annotations.DefectsWith(effect);
    }

    // RecordType stays bound to the discovery winner even though the columns are unioned: Mutagen's
    // EnumerateMajorRecords falls back to the abstract group base and returns every sibling's records
    // anyway, so pointing at the base would gain nothing.
    private static RecordTableSchema BuildSchema(
        string tableName, Type getterType, List<Type> siblingGetterTypes,
        GameReflection game, ILogger logger)
    {
        // Decided by sibling count, never table or signature name, so another game's multi-subclass
        // signature needs no change.
        var columns = siblingGetterTypes.Count > 1
            ? LoquiUnions.BuildUnionColumns(LoquiUnions.RecordUnion(siblingGetterTypes), game, logger)
            : ColumnReflection.ReflectColumns(getterType, game, logger);

        return new RecordTableSchema
        {
            TableName = tableName,
            DisplayName = RecordDisplayNames.For(tableName),
            RecordType = getterType,
            RecordColumns = columns,
        };
    }
}

/// <summary>A game release whose Mutagen record-type assembly is not referenced by this build. Its
/// own type because Mutagen's <see cref="FileNotFoundException"/> is not an actionable message for
/// a caller.</summary>
public sealed class UnsupportedGameReleaseException : Exception
{
    // RCS1194: the three standard exception constructors, for well-behaved rethrow/serialization
    // callers generally — not how SchemaReflector itself throws this (see the release-based
    // constructor below), which builds a specific, actionable message naming the missing assembly.
    public UnsupportedGameReleaseException()
    {
    }

    public UnsupportedGameReleaseException(string message) : base(message)
    {
    }

    public UnsupportedGameReleaseException(string message, Exception innerException) : base(message, innerException)
    {
    }

    internal UnsupportedGameReleaseException(GameRelease release, string assemblyName)
        : base($"Game release '{release}' is not supported by this build: the Mutagen assembly '{assemblyName}' is not referenced.")
    {
        Release = release;
    }

    public GameRelease Release { get; }
}
