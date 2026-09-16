using System.Linq.Expressions;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Serialization.Customizations;

namespace MEditService.Tests.Schema;

/// <summary>The embed customizations and the derived slots are one set, compared by replaying each
/// customization against a recording builder. A customization the derivation does not name would put
/// a child in a document no edit can reach.</summary>
public sealed class EmbedCustomizationsAreTheDerivedSlotsTests
{
    [Fact]
    public void TheCustomizationsEmbedExactlyTheDerivedSlots()
    {
        var customized = Replay().Order().ToList();

        // A build with no customization discovered would agree with an empty derivation.
        Assert.NotEmpty(customized);
        Assert.Equal(ContainerChildFields.EmbeddedSlots.Order().ToList(), customized);
    }

    // Every ICustomize<T> in the serialization folder, played back through a builder that records the
    // member each EmbedRecordsInSameFile names.
    private static IEnumerable<(string ParentType, string Slot)> Replay()
    {
        foreach (var found in typeof(ContainerChildFields).Assembly.GetTypes()
                     .Where(type => type is { IsClass: true, IsAbstract: false })
                     .Select(type => (Type: type, Customized: CustomizedType(type)))
                     .Where(found => found.Customized != null))
        {
            var customized = found.Customized
                ?? throw new InvalidOperationException($"Expected '{found.Type.Name}' to name a customized type.");
            var recorder = (IEmbedRecorder)(Activator.CreateInstance(typeof(RecordingBuilder<>).MakeGenericType(customized))
                ?? throw new InvalidOperationException($"Expected RecordingBuilder<{customized.Name}> to be constructible."));
            var customizeFor = typeof(ICustomize<>).MakeGenericType(customized)
                .GetMethod(nameof(ICustomize<IMajorRecordGetter>.CustomizeFor))
                ?? throw new InvalidOperationException($"Expected ICustomize<{customized.Name}> to declare CustomizeFor.");
            customizeFor.Invoke(Activator.CreateInstance(found.Type), [recorder]);

            var parent = ContainerChildFields.NormalizedTypeName(customized);
            foreach (var member in recorder.Embedded) yield return (parent, member);
        }
    }

    private static Type? CustomizedType(Type type) =>
        type.GetInterfaces()
            .FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(ICustomize<>))
            ?.GetGenericArguments()[0];

    private interface IEmbedRecorder
    {
        List<string> Embedded { get; }
    }

    private sealed class RecordingBuilder<TObject> : ICustomizationBuilder<TObject>, IEmbedRecorder
    {
        public List<string> Embedded { get; } = [];

        public ICustomizationBuilder<TObject> EmbedRecordsInSameFile(Expression<Func<TObject, IMajorRecordGetter?>> field) => Record(field);

        public ICustomizationBuilder<TObject> EmbedRecordsInSameFile(Expression<Func<TObject, IReadOnlyList<IMajorRecordGetter>?>> field) => Record(field);

        // ADR-0006 decision 3: neither customization exists, and a document that grew one would read
        // here as an unrecorded member rather than as a passing test.
        public ICustomizationBuilder<TObject> Omit<TField>(Expression<Func<TObject, TField>> field) =>
            throw new NotSupportedException("Omit drops real data (ADR-0006 decision 3).");

        public ICustomizationBuilder<TObject> Omit<TField>(Expression<Func<TObject, TField>> field, Func<TObject, TField, bool> predicate) =>
            throw new NotSupportedException("Omit drops real data (ADR-0006 decision 3).");

        private ICustomizationBuilder<TObject> Record(LambdaExpression field)
        {
            var body = field.Body is UnaryExpression converted ? converted.Operand : field.Body;
            Embedded.Add(((MemberExpression)body).Member.Name);
            return this;
        }
    }
}
