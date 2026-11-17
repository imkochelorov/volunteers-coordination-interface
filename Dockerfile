# syntax=docker/dockerfile:1
FROM eclipse-temurin:21-jdk AS build
WORKDIR /source
ENV GRADLE_USER_HOME=/opt/gradle-home
COPY --chmod=0755 gradlew ./
RUN sed -i 's/\r$//' gradlew
COPY settings.gradle.kts build.gradle.kts ./
COPY gradle/ gradle/
COPY src/ src/
COPY public/ public/
RUN --mount=type=cache,id=volunteers-coordination-gradle,target=/opt/gradle-home,sharing=locked \
    ./gradlew --no-daemon installDist

FROM eclipse-temurin:21-jre
WORKDIR /app
ENV HOST=0.0.0.0 PORT=4319 DATABASE_PATH=/app/data/app.sqlite
RUN groupadd --system coordination && useradd --system --gid coordination coordination \
    && mkdir -p /app/data && chown coordination:coordination /app/data
COPY --from=build /source/build/install/volunteers-coordination-interface/ /app/
USER coordination
EXPOSE 4319
ENTRYPOINT ["/app/bin/volunteers-coordination-interface"]
